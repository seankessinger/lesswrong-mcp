"""All network I/O and the per-event-loop HTTP lifecycle.

The pooled AsyncClient + concurrency semaphore, the SSRF redirect guard, the
retry/backoff/deadline choke point (`_request`), and the Markdown/GraphQL wrappers over it.
Callers must reach these THROUGH the module (`http_client._get_markdown(...)`) so the
hermetic suite can patch them (tests/conftest.py's IO_HOME seam).
"""
from __future__ import annotations

import asyncio
import weakref
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx

from lesswrong_mcp.config import (
    HTTP_TIMEOUT,
    HTTP_TOTAL_TIMEOUT,
    MAX_RETRIES,
    USER_AGENT,
    _ALLOWED_HOSTS,
    _CONCURRENCY_LIMIT,
    _base,
)

# --------------------------------------------------------------------------- #
# Per-event-loop HTTP client + concurrency limiter
#
# Created lazily per running loop. In stateless HTTP the SDK runs the lifespan per request,
# so the client is scoped to the process rather than the lifespan, keeping one pooled client
# across calls. Creation has no await, so it needs no lock. WeakKeyDictionary so a closed or
# collected loop drops its entry — and its client — instead of pinning one per loop forever.
# --------------------------------------------------------------------------- #
_LOOP_RESOURCES: weakref.WeakKeyDictionary[Any, tuple[httpx.AsyncClient, asyncio.Semaphore]] = (
    weakref.WeakKeyDictionary()
)
# True when serving stateless HTTP (set in main); tells _lifespan to leave the
# process-scoped client alone, since the SDK runs the lifespan per request there.
_STATELESS_HTTP = False


def _resources() -> tuple[httpx.AsyncClient, asyncio.Semaphore]:
    """Return the (pooled client, concurrency semaphore) for the running event loop,
    creating them lazily on first use."""
    loop = asyncio.get_running_loop()
    res = _LOOP_RESOURCES.get(loop)
    if res is None:
        client = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
            event_hooks={"response": [_block_offsite_redirect]},
        )
        res = (client, asyncio.Semaphore(_CONCURRENCY_LIMIT))
        _LOOP_RESOURCES[loop] = res
    return res


async def _aclose_client() -> None:
    """Close and forget the pooled client for the running loop (stdio shutdown)."""
    res = _LOOP_RESOURCES.pop(asyncio.get_running_loop(), None)
    if res is not None:
        await res[0].aclose()


async def _block_offsite_redirect(response: httpx.Response) -> None:
    """Refuse to follow a redirect off the allow-listed forum hosts. httpx runs this on each
    response — including the intermediate 3xx — before issuing the next hop, so raising here
    stops the off-host request from ever leaving the process, while still permitting the
    API's own same-host slug -> canonical-id redirects."""
    if response.is_redirect:
        location = response.headers.get("location")
        if location:
            target = response.url.join(location)
            if target.host not in _ALLOWED_HOSTS:
                raise RuntimeError(
                    f"Refused to follow a redirect off the forum host (to {target.host!r})."
                )


@asynccontextmanager
async def _lifespan(_server):
    """Close the pooled client on shutdown — but only in stdio mode, where this runs
    once for the process. Stateless HTTP runs the lifespan per request (_STATELESS_HTTP),
    so there it leaves the process-scoped client alone."""
    try:
        yield
    finally:
        if not _STATELESS_HTTP:
            await _aclose_client()


# --------------------------------------------------------------------------- #
# Shared HTTP layer (retry + backoff + politeness)
# --------------------------------------------------------------------------- #

def _parse_retry_after(value: str | None) -> float | None:
    """Seconds to wait per a Retry-After header, or None if absent/unparseable. Honours both
    RFC 7231 forms: delta-seconds and an HTTP-date (converted to seconds-from-now)."""
    if not value:
        return None
    value = value.strip()
    try:
        secs = float(value)
        return secs if secs >= 0 else None
    except ValueError:
        pass  # not delta-seconds; try the HTTP-date form
    try:
        from email.utils import parsedate_to_datetime

        target = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if target is None:
        return None
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    return max(0.0, (target - datetime.now(timezone.utc)).total_seconds())


async def _request(method: str, url: str, *, headers: dict | None = None, **kwargs) -> httpx.Response:
    """Single choke-point for all network I/O: retries 429/5xx with exponential backoff
    (honouring Retry-After) and transient transport/timeout errors, capping concurrency with
    a per-loop semaphore so the server stays a polite API citizen."""
    merged_headers = {"User-Agent": USER_AGENT}
    if headers:
        merged_headers.update(headers)

    client, semaphore = _resources()
    for attempt in range(MAX_RETRIES):
        is_last = attempt == MAX_RETRIES - 1
        try:
            # Hold a concurrency slot only for the actual network round-trip, not
            # across the backoff sleeps below, so a retrying request doesn't starve
            # unrelated calls of the (small) in-flight budget while it's just waiting.
            # wait_for bounds the total round-trip (httpx only has per-op timeouts).
            async with semaphore:
                resp = await asyncio.wait_for(
                    client.request(method, url, headers=merged_headers, **kwargs),
                    timeout=HTTP_TOTAL_TIMEOUT,
                )
            if resp.status_code in (429, 500, 502, 503, 504) and not is_last:
                hint = _parse_retry_after(resp.headers.get("retry-after"))
                # Honour an explicit Retry-After (capped generously to bound a
                # hostile/absurd value); only the self-computed backoff is capped tight.
                delay = min(hint, 60.0) if hint is not None else min(0.5 * (2 ** attempt), 8.0)
                await asyncio.sleep(delay)
                continue
            return resp  # success, or final attempt: caller surfaces the status
        except (httpx.TimeoutException, httpx.TransportError, asyncio.TimeoutError) as exc:
            if is_last:
                # Surface an overall-deadline breach as httpx's timeout type so it
                # flows through _handle_error like any other timeout.
                if isinstance(exc, asyncio.TimeoutError):
                    raise httpx.TimeoutException(
                        f"Request exceeded the overall {HTTP_TOTAL_TIMEOUT:.0f}s deadline."
                    ) from exc
                raise
            await asyncio.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("request retry loop exited without returning")  # unreachable


async def _get_markdown(site: str, path: str, params: dict | None = None) -> str:
    """GET a Markdown route under /api/* and return its text body."""
    url = _base(site) + path
    clean = {k: v for k, v in (params or {}).items() if v is not None}
    resp = await _request("GET", url, headers={"Accept": "text/markdown, */*"}, params=clean)
    resp.raise_for_status()
    return resp.text


async def _graphql(site: str, query: str, variables: dict | None = None) -> dict:
    """POST a GraphQL query and return the `data` object (raising on GraphQL errors)."""
    url = _base(site) + "/graphql"
    resp = await _request(
        "POST",
        url,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        json={"query": query, "variables": variables or {}},
    )
    # Surface GraphQL errors before raise_for_status: validation errors come back as
    # HTTP 400 *with* a descriptive `errors[]` body, which the status raise would hide.
    try:
        payload = resp.json()
    except ValueError as exc:
        # Non-JSON body: an error status surfaces as HTTPStatusError; a 2xx with an
        # unparseable body (raise_for_status is a no-op) surfaces as RuntimeError.
        resp.raise_for_status()
        raise RuntimeError("GraphQL endpoint returned a non-JSON response.") from exc
    # A well-formed GraphQL response is a JSON object. A 2xx body that parses to null, a
    # list, or a scalar would make the .get() calls below raise AttributeError and escape
    # the tool error funnel as an unexpected fault; fail as a clean RuntimeError instead.
    if not isinstance(payload, dict):
        resp.raise_for_status()
        raise RuntimeError("GraphQL endpoint returned a non-object JSON response.")
    errors = payload.get("errors")
    if errors:
        msgs = "; ".join(
            (e.get("message", "unknown error") if isinstance(e, dict) else str(e))
            for e in errors
        )
        raise RuntimeError(f"GraphQL error: {msgs}")
    resp.raise_for_status()  # a non-error, non-2xx response still surfaces its status
    return payload.get("data") or {}
