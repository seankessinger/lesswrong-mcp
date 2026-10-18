"""All network I/O and the per-event-loop HTTP lifecycle.

The pooled AsyncClient + concurrency semaphore, the SSRF redirect guard, the
retry/backoff/deadline choke point (`_request`), and the Markdown/GraphQL wrappers over it.
Callers must reach these THROUGH the module (`http_client._get_markdown(...)`) so the
hermetic suite can patch them (tests/conftest.py's IO_HOME seam).

Retries, a long Retry-After and refused redirects are logged at WARNING. Log lines carry the
URL path only: lw_search's query rides in the query string.
"""
from __future__ import annotations

import asyncio
import logging
import random
import weakref
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from lesswrong_mcp.config import (
    HTTP_TIMEOUT,
    HTTP_TOTAL_TIMEOUT,
    MAX_RETRIES,
    SITE_BASE_URLS,
    USER_AGENT,
    _CONCURRENCY_LIMIT,
    Site,
)
from lesswrong_mcp.errors import ForumAPIError

log = logging.getLogger(__name__)
# httpx logs every request URL at INFO, query string included, so a search query would reach
# the operator's log.
logging.getLogger("httpx").setLevel(logging.WARNING)

# --------------------------------------------------------------------------- #
# Per-event-loop HTTP client + concurrency limiter
#
# Created lazily per running loop and closed by the server's lifespan (server._lifespan) when
# that loop stops serving: MCPServer enters it once per run of the stdio transport. Creation has
# no await, so it needs no lock.
# WeakKeyDictionary so a closed or collected loop drops its entry — and its client — instead of
# pinning one per loop forever.
# --------------------------------------------------------------------------- #
_LOOP_RESOURCES: weakref.WeakKeyDictionary[Any, tuple[httpx.AsyncClient, asyncio.Semaphore]] = (
    weakref.WeakKeyDictionary()
)


def _resources() -> tuple[httpx.AsyncClient, asyncio.Semaphore]:
    """Return the (pooled client, concurrency semaphore) for the running event loop,
    creating them lazily on first use. A closed client is replaced; the semaphore is kept, so
    requests already queued on it stay counted."""
    loop = asyncio.get_running_loop()
    res = _LOOP_RESOURCES.get(loop)
    if res is None or res[0].is_closed:
        client = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
            event_hooks={"response": [_block_offsite_redirect]},
        )
        semaphore = res[1] if res is not None else asyncio.Semaphore(_CONCURRENCY_LIMIT)
        res = (client, semaphore)
        _LOOP_RESOURCES[loop] = res
    return res


async def _aclose_client() -> None:
    """Close and forget the pooled client for the running loop (the server's lifespan exit)."""
    res = _LOOP_RESOURCES.pop(asyncio.get_running_loop(), None)
    if res is not None:
        await res[0].aclose()


# The redirect allow-list: the two forum hosts as raw bytes, which httpx normalises (lowercased,
# IDNA-encoded) without decoding them back, so a host that isn't valid IDNA can't raise here.
_ALLOWED_HOSTS = frozenset(httpx.URL(u).raw_host for u in SITE_BASE_URLS.values())


async def _block_offsite_redirect(response: httpx.Response) -> None:
    """Refuse to follow a redirect anywhere but a forum's HTTPS origin. httpx runs this on
    each response — including the intermediate 3xx — before issuing the next hop, so raising
    here stops the request from ever leaving the process, while still permitting the API's
    own same-host slug -> canonical-id redirects. The scheme and port are pinned as well as
    the host: a plaintext hop to a forum host would let an on-path attacker rewrite the
    Markdown the model reads."""
    if not response.is_redirect:
        return
    location = response.headers.get("location")
    if not location:
        return
    try:
        target = response.url.join(location)
    except httpx.InvalidURL as exc:
        log.warning("Refused a malformed redirect from %s", response.url.path)
        raise ForumAPIError("Refused a malformed redirect from the forum.") from exc
    if (
        target.scheme != "https"
        or target.raw_host not in _ALLOWED_HOSTS
        or target.port not in (None, 443)
    ):
        origin = f"{target.scheme}://{target.netloc.decode('ascii')}"
        log.warning("Refused a redirect from %s to %s", response.url.path, origin)
        raise ForumAPIError(f"Refused to follow a redirect off the forum (to {origin!r}).")


# --------------------------------------------------------------------------- #
# Shared HTTP layer (retry + backoff + politeness)
# --------------------------------------------------------------------------- #

_RETRYABLE_STATUS = (429, 500, 502, 503, 504)
# The longest Retry-After the client waits out. A longer hint stops retrying: retrying sooner
# would land inside the window the forum asked to be left alone.
_MAX_RETRY_AFTER = 60.0


def _backoff(attempt: int) -> float:
    """Capped exponential backoff with jitter: a step of 0.5s doubling per attempt up to 8s.
    The floor of half the step keeps a retry polite; the random upper half spreads concurrent
    retries so they don't arrive in lockstep."""
    # The exponent is capped with the step: past attempt 4 the step is 8s anyway, and
    # 0.5 * 2 ** attempt overflows a float from attempt 1024 on, which LW_MAX_RETRIES allows.
    return 0.5 * 2 ** min(attempt, 4) * random.uniform(0.5, 1.0)


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
        target = parsedate_to_datetime(value)
    except (ValueError, OverflowError):  # unparseable, or a date field out of range
        return None
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    return max(0.0, (target - datetime.now(timezone.utc)).total_seconds())


async def _request(method: str, url: str, **kwargs: Any) -> httpx.Response:
    """Single choke-point for all network I/O: retries 429/5xx (up to MAX_RETRIES times after
    the first attempt, honouring a Retry-After up to _MAX_RETRY_AFTER, else jittered backoff)
    and transient transport errors, timeouts included, capping concurrency with a per-loop
    semaphore so the server stays a polite API citizen. `kwargs` go to the pooled client's
    request(), whose default headers carry the User-Agent."""
    path = httpx.URL(url).path

    for attempt in range(MAX_RETRIES + 1):
        is_last = attempt == MAX_RETRIES
        # Fetched per attempt, so a retry picks up a replacement for a client closed meanwhile.
        client, semaphore = _resources()
        try:
            # Hold a concurrency slot only for the actual network round-trip, not
            # across the backoff sleeps below, so a retrying request doesn't starve
            # unrelated calls of the (small) in-flight budget while it's just waiting.
            # wait_for bounds each attempt's whole round-trip (httpx only has per-op
            # timeouts). It is per attempt, not across the loop: retries and Retry-After
            # waits can deliberately stretch one call past it.
            async with semaphore:
                resp = await asyncio.wait_for(
                    client.request(method, url, **kwargs),
                    timeout=HTTP_TOTAL_TIMEOUT,
                )
        except (httpx.TransportError, asyncio.TimeoutError) as exc:
            if is_last:
                log.warning(
                    "%s %s -> %s; giving up after %d attempts",
                    method, path, type(exc).__name__, attempt + 1,
                )
                # Surface a per-attempt deadline breach as httpx's timeout type so it
                # flows through _handle_error like any other timeout. It speaks for the final
                # attempt only: earlier ones may have failed some other way.
                if isinstance(exc, asyncio.TimeoutError):
                    raise httpx.TimeoutException(
                        f"The final attempt exceeded the {HTTP_TOTAL_TIMEOUT:g}s per-attempt deadline."
                    ) from exc
                raise
            delay = _backoff(attempt)
            log.warning(
                "%s %s -> %s; retry %d/%d in %.1fs",
                method, path, type(exc).__name__, attempt + 1, MAX_RETRIES, delay,
            )
            await asyncio.sleep(delay)
            continue

        if resp.status_code not in _RETRYABLE_STATUS:
            return resp
        if is_last:
            log.warning(
                "%s %s -> HTTP %d; giving up after %d attempts",
                method, path, resp.status_code, attempt + 1,
            )
            return resp  # the caller surfaces the status
        hint = _parse_retry_after(resp.headers.get("retry-after"))
        if hint is not None and hint > _MAX_RETRY_AFTER:
            log.warning(
                "%s %s -> HTTP %d with Retry-After %.0fs, beyond the %.0fs this client waits; "
                "not retrying",
                method, path, resp.status_code, hint, _MAX_RETRY_AFTER,
            )
            return resp
        # The forum's own Retry-After is honoured as given; only self-computed backoff is jittered.
        delay = hint if hint is not None else _backoff(attempt)
        log.warning(
            "%s %s -> HTTP %d; retry %d/%d in %.1fs",
            method, path, resp.status_code, attempt + 1, MAX_RETRIES, delay,
        )
        await asyncio.sleep(delay)
    raise RuntimeError("request retry loop exited without returning")  # unreachable


async def _get_markdown(site: Site, path: str, params: dict | None = None) -> str:
    """GET a Markdown route under /api/* and return its text body."""
    url = SITE_BASE_URLS[site] + path
    clean = {k: v for k, v in (params or {}).items() if v is not None}
    resp = await _request("GET", url, headers={"Accept": "text/markdown, */*"}, params=clean)
    resp.raise_for_status()
    return resp.text


async def _graphql(site: Site, query: str, variables: dict | None = None) -> dict:
    """POST a GraphQL query and return the `data` object (raising on GraphQL errors)."""
    url = SITE_BASE_URLS[site] + "/graphql"
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
        # unparseable body (raise_for_status is a no-op) surfaces as ForumAPIError.
        resp.raise_for_status()
        raise ForumAPIError("GraphQL endpoint returned a non-JSON response.") from exc
    # A malformed body must fail as a ForumAPIError the tool funnel reports, never as an
    # AttributeError/TypeError from trusting its shape. A well-formed response is a JSON
    # object whose errors[] is a list of {message} objects and whose `data` is an object or
    # null; anything else is normalised or refused here.
    if not isinstance(payload, dict):
        resp.raise_for_status()
        raise ForumAPIError("GraphQL endpoint returned a non-object JSON response.")
    errors = payload.get("errors")
    if errors:
        entries = errors if isinstance(errors, list) else [str(errors)]
        msgs = "; ".join(
            str(e.get("message") or "unknown error") if isinstance(e, dict) else str(e)
            for e in entries
        )
        raise ForumAPIError(f"GraphQL error: {msgs}")
    resp.raise_for_status()  # a non-error, non-2xx response still surfaces its status
    data = payload.get("data")
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ForumAPIError("GraphQL endpoint returned non-object data.")
    return data
