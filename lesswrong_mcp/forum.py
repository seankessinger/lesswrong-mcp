"""All network I/O: one pooled client per event loop, retries, a concurrency cap and a redirect
guard, behind three fetchers (Markdown routes, GraphQL, POST search).

Callers reach these through the module (`forum.graphql(...)`), so the test suite can fake the
transport in one place. Retries and refused redirects are logged at WARNING with the URL path
only.
"""
from __future__ import annotations

import asyncio
import importlib.metadata
import logging
import random
import weakref
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

VERSION = importlib.metadata.version("lesswrong-mcp")
# The "+URL" names where the forum's operators can find this client and its maintainer.
USER_AGENT = (
    f"lesswrong-mcp/{VERSION} "
    "(+https://github.com/seankessinger/lesswrong-mcp; read-only research client)"
)
# Both forums are one deployment; everything is read from LessWrong's host.
BASE = "https://www.lesswrong.com"

TIMEOUT = 30.0
CONCURRENCY = 4
MAX_RETRIES = 2
RETRYABLE_STATUS = (429, 500, 502, 503, 504)
# The longest Retry-After waited out. A longer one ends the call: retrying sooner would land
# inside the window the forum asked to be left alone.
MAX_RETRY_AFTER = 60.0

log = logging.getLogger(__name__)
# httpx logs every request URL at INFO, query string included.
logging.getLogger("httpx").setLevel(logging.WARNING)


class ForumError(Exception):
    """An anticipated forum failure whose str() is the user-facing message: a GraphQL error, a
    malformed body, or a refused redirect."""


# --------------------------------------------------------------------------- client per loop

# Weak keys, so a closed or collected loop drops its client instead of pinning it.
_LOOP_RESOURCES: weakref.WeakKeyDictionary[Any, tuple[httpx.AsyncClient, asyncio.Semaphore]] = (
    weakref.WeakKeyDictionary()
)


def _resources() -> tuple[httpx.AsyncClient, asyncio.Semaphore]:
    """The pooled client and concurrency semaphore for the running loop, created on first use.
    A closed client is replaced; the semaphore is kept, so queued requests stay counted."""
    loop = asyncio.get_running_loop()
    res = _LOOP_RESOURCES.get(loop)
    if res is None or res[0].is_closed:
        client = httpx.AsyncClient(
            timeout=TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
            event_hooks={"response": [_block_offsite_redirect]},
        )
        semaphore = res[1] if res is not None else asyncio.Semaphore(CONCURRENCY)
        res = (client, semaphore)
        _LOOP_RESOURCES[loop] = res
    return res


async def close() -> None:
    """Close and forget the running loop's pooled client (the server lifespan's exit)."""
    res = _LOOP_RESOURCES.pop(asyncio.get_running_loop(), None)
    if res is not None:
        await res[0].aclose()


# The two forum hosts, as httpx's normalised raw bytes, so a host that isn't valid IDNA is
# refused rather than raised.
_ALLOWED_HOSTS = frozenset({b"www.lesswrong.com", b"www.alignmentforum.org"})


async def _block_offsite_redirect(response: httpx.Response) -> None:
    """Refuse to follow a redirect anywhere but a forum's HTTPS origin. httpx runs this hook
    before each next hop. A plaintext hop to a forum host is refused too: it would let an
    on-path attacker rewrite the text the model reads."""
    if not response.is_redirect:
        return
    location = response.headers.get("location")
    if not location:
        return
    try:
        target = response.url.join(location)
    except httpx.InvalidURL as exc:
        log.warning("Refused a malformed redirect from %s", response.url.path)
        raise ForumError("Refused a malformed redirect from the forum.") from exc
    if target.scheme != "https" or target.raw_host not in _ALLOWED_HOSTS or target.port not in (None, 443):
        origin = f"{target.scheme}://{target.netloc.decode('ascii')}"
        log.warning("Refused a redirect from %s to %s", response.url.path, origin)
        raise ForumError(f"Refused to follow a redirect off the forum (to {origin!r}).")


# --------------------------------------------------------------------------- retries

def _backoff(attempt: int) -> float:
    """Capped exponential backoff with jitter: 0.5s doubling per attempt up to 8s, scaled by a
    random factor in [0.5, 1) so concurrent retries don't arrive in lockstep."""
    return 0.5 * 2 ** min(attempt, 4) * random.uniform(0.5, 1.0)


def _parse_retry_after(value: str | None) -> float | None:
    """Seconds to wait per a Retry-After header (delta-seconds or an HTTP-date), or None."""
    if not value:
        return None
    value = value.strip()
    try:
        secs = float(value)
        return secs if secs >= 0 else None
    except ValueError:
        pass
    try:
        target = parsedate_to_datetime(value)
    except (ValueError, OverflowError):
        return None
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    return max(0.0, (target - datetime.now(timezone.utc)).total_seconds())


async def _request(method: str, url: str, **kwargs: Any) -> httpx.Response:
    """The one choke point for network I/O. Retries the retryable statuses and transport errors
    up to MAX_RETRIES times, sleeping the forum's Retry-After (up to MAX_RETRY_AFTER) or a
    jittered backoff. A concurrency slot is held only for the round trip, not across sleeps."""
    path = httpx.URL(url).path
    for attempt in range(MAX_RETRIES + 1):
        is_last = attempt == MAX_RETRIES
        client, semaphore = _resources()
        try:
            async with semaphore:
                resp = await client.request(method, url, **kwargs)
        except httpx.TransportError as exc:
            if is_last:
                log.warning("%s %s -> %s; giving up after %d attempts", method, path, type(exc).__name__, attempt + 1)
                raise
            delay = _backoff(attempt)
            log.warning("%s %s -> %s; retry %d/%d in %.1fs", method, path, type(exc).__name__, attempt + 1, MAX_RETRIES, delay)
            await asyncio.sleep(delay)
            continue

        if resp.status_code not in RETRYABLE_STATUS:
            return resp
        if is_last:
            log.warning("%s %s -> HTTP %d; giving up after %d attempts", method, path, resp.status_code, attempt + 1)
            return resp
        hint = _parse_retry_after(resp.headers.get("retry-after"))
        if hint is not None and hint > MAX_RETRY_AFTER:
            log.warning("%s %s -> HTTP %d with Retry-After %.0fs; not retrying", method, path, resp.status_code, hint)
            return resp
        delay = hint if hint is not None else _backoff(attempt)
        log.warning("%s %s -> HTTP %d; retry %d/%d in %.1fs", method, path, resp.status_code, attempt + 1, MAX_RETRIES, delay)
        await asyncio.sleep(delay)
    raise AssertionError("unreachable: the last attempt returns or raises")


# --------------------------------------------------------------------------- fetchers

async def markdown(path: str) -> str:
    """GET a Markdown route under BASE and return its text."""
    resp = await _request("GET", BASE + path, headers={"Accept": "text/markdown, */*"})
    resp.raise_for_status()
    return resp.text


async def graphql(query: str, variables: dict[str, Any]) -> dict[str, Any]:
    """POST a GraphQL query and return its `data`. GraphQL errors are surfaced before the status
    check: a validation error arrives as HTTP 400 with a useful `errors[]` body."""
    resp = await _request("POST", BASE + "/graphql", json={"query": query, "variables": variables})
    try:
        payload = resp.json()
    except ValueError as exc:
        resp.raise_for_status()
        raise ForumError("The forum's GraphQL endpoint sent a response that isn't JSON.") from exc
    if not isinstance(payload, dict):
        resp.raise_for_status()
        raise ForumError("The forum's GraphQL endpoint sent a malformed response.")
    errors = payload.get("errors")
    if errors:
        entries = errors if isinstance(errors, list) else [errors]
        msgs = "; ".join(str(e.get("message") or "unknown error") if isinstance(e, dict) else str(e) for e in entries)
        raise ForumError(f"GraphQL error: {msgs}")
    resp.raise_for_status()
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise ForumError("The forum's GraphQL endpoint sent a malformed response.")
    return data


async def search(queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """POST one or more queries to the search index and return one result per query."""
    resp = await _request("POST", BASE + "/api/search", json=queries)
    resp.raise_for_status()
    try:
        payload = resp.json()
    except ValueError as exc:
        raise ForumError("The forum's search sent a response that isn't JSON.") from exc
    results = payload.get("results") if isinstance(payload, dict) else payload
    if not isinstance(results, list):
        raise ForumError("The forum's search sent a malformed response.")
    return results
