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
    http_ok: int = 0
    http_failed: int = 0
    blocked: int = 0
    stealth_ok: int = 0
    stealth_failed: int = 0
    domains: dict[str, int] = field(default_factory=dict)

    def record_domain(self, url: str) -> None:
        try:
            from urllib.parse import urlsplit

            domain = urlsplit(url).netloc.lower()
        except Exception:
            domain = ""
        if domain:
            self.domains[domain] = self.domains.get(domain, 0) + 1

    def summary(self) -> str:
        return (
            f"http_ok={self.http_ok} http_failed={self.http_failed} "
            f"blocked={self.blocked} stealth_ok={self.stealth_ok} "
            f"stealth_failed={self.stealth_failed}"
        )


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
                return None
            if status is not None and not 200 <= int(status) < 300:
                self.stats.http_failed += 1
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
                if not response_is_blocked(status, body) and (
                    status is None or 200 <= int(status) < 400
                ):
                    self.stats.http_ok += 1
                    self.stats.record_domain(url)
                    return body
                self.stats.blocked += 1
            except Exception:  # noqa: BLE001
                self.stats.http_failed += 1

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
            if response_is_blocked(status, body):
                self.stats.blocked += 1
                kwargs["solve_cloudflare"] = True
                kwargs["timeout"] = 75_000
                response = self._stealth_call(stealth.fetch, url, **kwargs)
                body = decode_response_body(response)
                status = getattr(response, "status", None)
                if response_is_blocked(status, body):
                    self.stats.blocked += 1
                    self.stats.stealth_failed += 1
                    return None
            self.stats.stealth_ok += 1
            self.stats.record_domain(url)
            return body
        except Exception:  # noqa: BLE001
            self.stats.stealth_failed += 1
            return None
