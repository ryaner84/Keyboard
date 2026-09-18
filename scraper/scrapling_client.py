"""Optional Scrapling acquisition layer for the GMK Tracker scraper.

Scrapling is deliberately limited to fetching pages and JSON. Product
classification, variant selection, currency validation, and stock decisions
remain in scrape.py, where the application's domain rules live.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from typing import Any, Callable


LogFn = Callable[[str], None]

_BLOCKED_STATUSES = {401, 403, 407, 429, 503}
_BLOCK_MARKERS = (
    "cf-chl-",
    "cloudflare ray id",
    "checking your browser",
    "just a moment...",
    "please verify you are a human",
    "access denied",
    "temporarily blocked",
)


def response_is_blocked(status: int | None, body: str) -> bool:
    """Return True when a response looks like a bot challenge/block page."""
    if status in _BLOCKED_STATUSES:
        return True
    lowered = body[:250_000].lower()
    return any(marker in lowered for marker in _BLOCK_MARKERS)


def response_is_readable(status: int | None, body: str) -> bool:
    """True when `body` IS the page that was asked for.

    An ERROR STATUS IS NOT A PAGE, and this is the one place that rule is
    written. `response_is_blocked` above answers a narrower question — does this
    look like a bot challenge — off a hand-written list of five statuses, and
    every caller that needed the whole question wrote the rest of it itself:
    `_fetch_page_html` as `int(status) < 400`, `_front_page_html` as
    `response.ok`, `get_html`'s plain path as `200 <= int(status) < 400`. The
    one caller that did NOT is the one that decides a listing's diagnosis.

    `generic_price` (scrape.py) took `page.content()` whenever the status was
    not one of those five and parsed it as the product page. `page.content()` is
    never empty — Chromium renders a document for every error — so a store
    answering 423, 402, 451 or a 5xx had its ERROR PAGE read, found to carry no
    product markup, and recorded as NO_PRODUCT_DATA: "teach the parser this
    platform", the one verdict that names a code change here and that no number
    of re-scrapes can end. Probed from a runner on 2026-09-18, thockeys.com
    answers 423 on every route, its own front door included, and both of its
    listings — all it has — were filed that way.

    A 404/410 is refused here like any other error status, and that is what
    makes the caller's dead-link branch reachable at all: `generic_price` only
    consults DEAD_LINK_STATUSES when no transport produced a page, and a
    rendered 404 body meant the browser always "succeeded". So the nightly could
    never mark a non-Shopify listing gone by status — `deadSince`, the only
    signal allowed to take a listing off the site, was left to the four-times-a-
    day pass alone. `prices.ts` has always refused any non-ok status outright
    (`if (!res.ok) return isDeadLinkStatus(res.status) ? DEAD_LINK : null`);
    this is the mirror of that `res.ok`, and the verdict still belongs to the
    caller, never to this predicate.

    `status is None` stays readable: Playwright hands back no response for a
    same-document navigation, and every call site has always treated that as
    "no status to judge" rather than as a failure.
    """
    if status is not None:
        try:
            code = int(status)
        except (TypeError, ValueError):
            return False
        if not 200 <= code < 300:
            return False
    return not response_is_blocked(status, body)


def decode_response_body(response: Any) -> str:
    body = getattr(response, "body", b"")
    if isinstance(body, str):
        return body
    if not isinstance(body, (bytes, bytearray)):
        return str(body or "")
    encoding = getattr(response, "encoding", None) or "utf-8"
    try:
        return bytes(body).decode(encoding, errors="replace")
    except (LookupError, TypeError):
        return bytes(body).decode("utf-8", errors="replace")


@dataclass
class ScraplingStats:
    """Fetch outcomes, tracked per domain so blocks can be attributed.

    The totals alone are not actionable: a run once reported blocked=424 with no
    record of WHICH hosts blocked us, because record_domain was only ever called
    on the success paths and the resulting dict was never printed. Blocked and
    failed fetches are now attributed too, and surfaced by problem_summary().
    """

    http_ok: int = 0
    http_failed: int = 0
    blocked: int = 0
    stealth_ok: int = 0
    stealth_failed: int = 0
    domains: dict[str, int] = field(default_factory=dict)
    blocked_domains: dict[str, int] = field(default_factory=dict)
    failed_domains: dict[str, int] = field(default_factory=dict)

    @staticmethod
    def _domain_of(url: str) -> str:
        try:
            from urllib.parse import urlsplit

            return urlsplit(url).netloc.lower()
        except Exception:
            return ""

    @staticmethod
    def _bump(bucket: dict[str, int], url: str) -> None:
        domain = ScraplingStats._domain_of(url)
        if domain:
            bucket[domain] = bucket.get(domain, 0) + 1

    def record_domain(self, url: str) -> None:
        self._bump(self.domains, url)

    def record_blocked(self, url: str) -> None:
        self._bump(self.blocked_domains, url)

    def record_failed(self, url: str) -> None:
        self._bump(self.failed_domains, url)

    def summary(self) -> str:
        return (
            f"http_ok={self.http_ok} http_failed={self.http_failed} "
            f"blocked={self.blocked} stealth_ok={self.stealth_ok} "
            f"stealth_failed={self.stealth_failed}"
        )

    def problem_summary(self, limit: int = 8) -> str:
        """Worst offending hosts as 'host blocked=N failed=M', or '' if clean.

        This is the line that tells you whether a bad run means one store is
        rate-limiting you or the whole network path is down.
        """
        hosts = set(self.blocked_domains) | set(self.failed_domains)
        if not hosts:
            return ""
        ranked = sorted(
            hosts,
            key=lambda h: (
                self.blocked_domains.get(h, 0) + self.failed_domains.get(h, 0)
            ),
            reverse=True,
        )
        parts = []
        for host in ranked[:limit]:
            blocked = self.blocked_domains.get(host, 0)
            failed = self.failed_domains.get(host, 0)
            detail = " ".join(
                bit for bit in (
                    f"blocked={blocked}" if blocked else "",
                    f"failed={failed}" if failed else "",
                ) if bit
            )
            parts.append(f"{host} {detail}")
        if len(ranked) > limit:
            parts.append(f"(+{len(ranked) - limit} more host(s))")
        return "; ".join(parts)


class ScraplingClient:
    """Resilient fetch client with cheap HTTP and lazy stealth-browser modes."""

    def __init__(
        self,
        *,
        headless: bool,
        logger: LogFn,
        enabled: bool = True,
    ) -> None:
        env_value = os.environ.get("SCRAPER_SCRAPLING", "1").strip().lower()
        self.enabled = enabled and env_value not in {"0", "false", "off", "no"}
        self.headless = headless
        self.log = logger
        self.stats = ScraplingStats()
        self._fetcher_session_type: Any = None
        self._stealth_session_type: Any = None
        self._http_context: Any = None
        self._http: Any = None
        self._stealth_context: Any = None
        self._stealth: Any = None
        self._stealth_profile: str | None = None
        # The stealth browser is Playwright-sync under the hood; starting or
        # using it on a thread that has a RUNNING asyncio event loop raises
        # "Playwright Sync API inside the asyncio loop" (this killed every
        # stealth fallback in one nightly run). A dedicated single worker
        # thread has no loop and also satisfies Playwright's same-thread rule.
        self._stealth_executor: ThreadPoolExecutor | None = None
        self._import_error: Exception | None = None

    @property
    def available(self) -> bool:
        return self.enabled and self._http is not None

    def __enter__(self) -> "ScraplingClient":
        if not self.enabled:
            self.log("Scrapling acquisition disabled; using Playwright only.")
            return self

        try:
            from scrapling.fetchers import FetcherSession, StealthySession

            # Scrapling logs every successful request at INFO. The nightly run
            # can make hundreds of requests, so keep console/log output focused
            # on recoveries, failures, and the aggregate counters below.
            logging.getLogger("scrapling").setLevel(logging.WARNING)
            self._fetcher_session_type = FetcherSession
            self._stealth_session_type = StealthySession
            self._http_context = FetcherSession(
                impersonate="chrome",
                stealthy_headers=True,
                timeout=30,
                retries=2,
                retry_delay=1,
            )
            self._http = self._http_context.__enter__()
            try:
                installed = version("scrapling")
            except PackageNotFoundError:
                installed = "unknown"
            self.log(
                f"Scrapling {installed} enabled "
                "(browser-impersonated HTTP; stealth browser starts only on fallback)."
            )
        except Exception as exc:  # noqa: BLE001
            self._import_error = exc
            self._http_context = None
            self._http = None
            self.log(
                "Scrapling unavailable "
                f"({type(exc).__name__}: {exc}); using Playwright only."
            )
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self._stealth_context is not None:
            try:
                # Same thread that created it must tear it down.
                self._stealth_call(
                    self._stealth_context.__exit__, exc_type, exc, traceback
                )
            except Exception:  # noqa: BLE001
                pass
        if self._stealth_executor is not None:
            self._stealth_executor.shutdown(wait=False)
            self._stealth_executor = None
        if self._http_context is not None:
            try:
                self._http_context.__exit__(exc_type, exc, traceback)
            except Exception:  # noqa: BLE001
                pass
        if self._stealth_profile:
            shutil.rmtree(self._stealth_profile, ignore_errors=True)

    def _stealth_call(self, fn: Callable, *args: Any, **kwargs: Any) -> Any:
        """Run fn on the dedicated stealth thread (created lazily)."""
        if self._stealth_executor is None:
            self._stealth_executor = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="scrapling-stealth"
            )
        return self._stealth_executor.submit(fn, *args, **kwargs).result()

    def _ensure_stealth(self) -> Any:
        if not self.available or self._stealth_session_type is None:
            return None
        if self._stealth is not None:
            return self._stealth
        try:
            # The explicit disposable profile makes the fallback independent
            # from the saved Playwright profile and gives the launcher a stable
            # process-path marker to clean after an interrupted run.
            self._stealth_profile = tempfile.mkdtemp(
                prefix="gmk-tracker-browser-profile-scrapling-"
            )
            def start() -> Any:
                self._stealth_context = self._stealth_session_type(
                    headless=self.headless,
                    solve_cloudflare=False,
                    block_ads=True,
                    timeout=75_000,
                    retries=2,
                    retry_delay=2,
                    google_search=True,
                    user_data_dir=self._stealth_profile,
                )
                return self._stealth_context.__enter__()

            self._stealth = self._stealth_call(start)
            self.log("Scrapling stealth browser started for protected-page fallback.")
            return self._stealth
        except Exception as exc:  # noqa: BLE001
            self.stats.stealth_failed += 1
            self.log(
                "  Scrapling stealth browser failed to start "
                f"({type(exc).__name__}: {exc})."
            )
            self._stealth_context = None
            self._stealth = None
            if self._stealth_profile:
                shutil.rmtree(self._stealth_profile, ignore_errors=True)
                self._stealth_profile = None
            return None

    def get_json(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        cookies: dict[str, str] | None = None,
    ) -> Any | None:
        """Fetch JSON using browser-TLS impersonation and session cookies."""
        if not self.available:
            return None
        try:
            response = self._http.get(
                url,
                headers=headers,
                cookies=cookies,
                follow_redirects=True,
            )
            body = decode_response_body(response)
            status = getattr(response, "status", None)
            if response_is_blocked(status, body):
                self.stats.blocked += 1
                self.stats.record_blocked(url)
                return None
            # Same rule as response_is_readable, kept as its own branch only so
            # an error status is attributed to `http_failed` rather than to
            # `blocked` — the two counts are what tell a refusal apart from a
            # challenge in problem_summary().
            if not response_is_readable(status, body):
                self.stats.http_failed += 1
                self.stats.record_failed(url)
                return None
            try:
                data = response.json()
            except Exception:
                data = json.loads(body)
            self.stats.http_ok += 1
            self.stats.record_domain(url)
            return data
        except Exception:  # noqa: BLE001
            self.stats.http_failed += 1
            self.stats.record_failed(url)
            return None

    def get_html(
        self,
        url: str,
        *,
        protected: bool = False,
        wait_selector: str | None = None,
        wait_ms: int = 0,
    ) -> str | None:
        """Fetch HTML, escalating to a stealth browser for protected pages."""
        if not self.available:
            return None

        if not protected:
            try:
                response = self._http.get(url, follow_redirects=True)
                body = decode_response_body(response)
                status = getattr(response, "status", None)
                if response_is_readable(status, body):
                    self.stats.http_ok += 1
                    self.stats.record_domain(url)
                    return body
                self.stats.blocked += 1
                self.stats.record_blocked(url)
            except Exception:  # noqa: BLE001
                self.stats.http_failed += 1
                self.stats.record_failed(url)

        stealth = self._ensure_stealth()
        if stealth is None:
            return None
        try:
            kwargs: dict[str, Any] = {
                "solve_cloudflare": False,
                "network_idle": True,
                "wait": wait_ms,
            }
            if wait_selector:
                kwargs["wait_selector"] = wait_selector
                kwargs["wait_selector_state"] = "attached"
            response = self._stealth_call(stealth.fetch, url, **kwargs)
            body = decode_response_body(response)
            status = getattr(response, "status", None)
            if not response_is_readable(status, body):
                if not response_is_blocked(status, body):
                    # An error STATUS, not a challenge page. There is nothing
                    # for solve_cloudflare to solve, so the 75s retry below is
                    # pure cost — and returning the body would hand the caller
                    # a 404/423 error document to parse as the product page.
                    self.stats.http_failed += 1
                    self.stats.record_failed(url)
                    return None
                self.stats.blocked += 1
                self.stats.record_blocked(url)
                kwargs["solve_cloudflare"] = True
                kwargs["timeout"] = 75_000
                response = self._stealth_call(stealth.fetch, url, **kwargs)
                body = decode_response_body(response)
                status = getattr(response, "status", None)
                if not response_is_readable(status, body):
                    # Same URL, already counted as blocked above — counting the
                    # retry again inflated `blocked` by up to 3x for one URL and
                    # made the totals useless for judging severity.
                    self.stats.stealth_failed += 1
                    return None
            self.stats.stealth_ok += 1
            self.stats.record_domain(url)
            return body
        except Exception:  # noqa: BLE001
            self.stats.stealth_failed += 1
            self.stats.record_failed(url)
            return None
