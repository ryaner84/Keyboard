"""
GMK price-locator scraper — runs on the Windows AWS WorkSpace.

Why this exists: Vercel's server-side fetch() is blocked (HTTP 403) by bot
protection on gmk.net (per-kit render images) and on Cloudflare-fronted vendor
Shopify stores (prices). A REAL headful Chromium on the WorkSpace presents a
genuine TLS/JS fingerprint and a persistent cf_clearance cookie, so it succeeds
where the serverless scraper fails.

It writes directly into the SAME Supabase Postgres DB the Vercel site reads,
so updates appear live with no deploy:
  - GroupBuy.images[]  (+ imageUrl = images[0])   from gmk.net galleries,
    trimmed to the MAIN product gallery (related-products carousels excluded)
    and REBUILT on every visit so polluted galleries self-heal
  - VendorKit.price/currency/variants/priceUpdatedAt/priceSource='SCRAPED'
    for BASE kits only — the price stored is the BASE kit variant (never the
    cheapest add-on), bounded to a plausible range (30–500 in western
    currencies)
  - GroupBuy(productType='KEYBOARD') rows for keyboard group buys scraped from
    vendor Shopify collections (NovelKeys, CannonKeys, KBDfans, MatrixLab, …).
    This pass replaced the Vercel /api/cron/keyboards job, which returned 0
    because serverless IPs are blocked and the build couldn't migrate the DB.

It NEVER overwrites a price whose priceSource = 'MANUAL', nor an admin-set
keyboard layout / mount / material.

Run via scraper/run-scraper.bat (which git-pulls the latest copy first).
"""

from __future__ import annotations

import argparse
import configparser
import csv
import getpass
import json
import os
import random
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone, timedelta
from html import unescape as html_unescape
from pathlib import Path

import psycopg2
from psycopg2 import OperationalError
from psycopg2.extras import RealDictCursor
from playwright.sync_api import sync_playwright, Page, BrowserContext
from scrapling_client import ScraplingClient, response_is_blocked

# ----------------------------------------------------------------------------
# Paths & config
# ----------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.ini"
LOCAL_CONFIG_PATH = HERE / "config.local.ini"
CREDENTIALS_PATH = HERE / "credentials.csv"


def _default_profile_dir() -> Path:
    override = os.environ.get("SCRAPER_PROFILE_DIR")
    if override:
        return Path(os.path.expandvars(override)).expanduser()

    # The checkout can belong to a different Windows account than the account
    # running Task Scheduler. Chromium needs full write access throughout its
    # profile (Crashpad, cache, history, password databases), so keep it under
    # the current account's Local AppData instead of beside the repository.
    local_app_data = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local_app_data:
        return Path(local_app_data) / "gmk-tracker" / "scraper-profile"

    return HERE / ".scraper-profile"


PROFILE_DIR = _default_profile_dir()
LOG_DIR = HERE / "logs"
GH_SEEN_PATH = HERE / "gh_seen.json"  # topic_id → last_post_at ISO — never committed
LK_SEEN_PATH = HERE / "lk_seen.json"  # Lightning Keyboards scrape state — never committed

# Time budget so a stuck run can't hang the machine forever (no serverless cap).
SCRAPE_BUDGET_MS = 30 * 60 * 1000  # 30 minutes
NAV_TIMEOUT_MS = 30_000

# Geekhack board 70.0 — Group Buys (keycaps + keyboards)
GEEKHACK_BOARD_URL = "https://geekhack.org/index.php?board=70.0"
GEEKHACK_MIN_YEAR = 2026          # skip threads whose last post predates this year
GEEKHACK_DELAY_MIN = 4.0          # seconds — random jitter between thread opens
GEEKHACK_DELAY_MAX = 9.0

SGT = timezone(timedelta(hours=8))  # Singapore — GMT+8, no DST

_LOG_FILE = None  # set in main() once LOG_DIR exists


def log(msg: str) -> None:
    stamp = datetime.now(SGT).strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp} SGT] {msg}"
    print(line, flush=True)
    if _LOG_FILE is not None:
        try:
            with _LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:  # noqa: BLE001
            pass


# ----------------------------------------------------------------------------
# Connection string (mirrors src/lib/database-url.ts Setup C)
# ----------------------------------------------------------------------------
PLACEHOLDER_REF = "your-project-ref"

# Parse a Supabase session-pooler connection string:
#   postgresql://postgres.<ref>:<password>@<host>:5432/postgres
# Captures group(1)=ref, group(2)=host.
_CONN_RE = re.compile(
    r"postgres(?:ql)?://postgres\.([A-Za-z0-9]+):[^@]*@([^:/\s]+)",
    re.IGNORECASE,
)
# Pull the region out of a pooler host like aws-1-ap-northeast-1.pooler.supabase.com
_REGION_RE = re.compile(r"aws-\d+-([a-z0-9-]+)\.pooler", re.IGNORECASE)


def save_local_config(ref: str, host: str, region: str) -> None:
    """Persist connection details to the gitignored config.local.ini.

    We never write to the tracked config.ini: that keeps your project ref/host
    out of git and avoids merge conflicts when run-scraper.bat does git pull.
    """
    local = configparser.ConfigParser()
    if LOCAL_CONFIG_PATH.exists():
        local.read(LOCAL_CONFIG_PATH)
    if not local.has_section("supabase"):
        local.add_section("supabase")
    local["supabase"]["project_ref"] = ref
    local["supabase"]["host"] = host
    if region:
        local["supabase"]["region"] = region
    with LOCAL_CONFIG_PATH.open("w", encoding="utf-8") as f:
        local.write(f)
    log(f"Saved connection details to {LOCAL_CONFIG_PATH.name} (gitignored).")


def prompt_connection() -> tuple[str, str, str]:
    """Ask for the full Supabase connection string and parse ref + host from it."""
    if not sys.stdin or not sys.stdin.isatty():
        log("ERROR: no Supabase connection configured and no terminal to prompt. "
            "Run scraper/run-scraper.bat manually once to enter it.")
        sys.exit(1)
    print()
    print("Paste your Supabase SESSION POOLER connection string.")
    print("  Supabase -> Project Settings -> Database -> Connection string -> Session pooler")
    print("Example:")
    print("  postgresql://postgres.abcdef123:[YOUR-PASSWORD]@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres")
    while True:
        raw = input("Connection string: ").strip()
        m = _CONN_RE.search(raw)
        if m:
            ref, host = m.group(1), m.group(2)
            rm = _REGION_RE.search(host)
            region = rm.group(1) if rm else ""
            return ref, host, region
        # Fallback to manual entry if the paste couldn't be parsed.
        print("  Couldn't parse that. Enter the two values manually instead:")
        ref = input("    project ref (the part after 'postgres.'): ").strip()
        host = input("    pooler host (aws-...pooler.supabase.com): ").strip()
        if ref and host and ref != PLACEHOLDER_REF:
            rm = _REGION_RE.search(host)
            return ref, host, (rm.group(1) if rm else "")
        print("  (still incomplete — try again)")


def load_config() -> dict:
    # Local override file takes precedence over the committed template.
    cfg = configparser.ConfigParser()
    cfg.read([str(CONFIG_PATH), str(LOCAL_CONFIG_PATH)])
    s = cfg["supabase"] if cfg.has_section("supabase") else {}

    ref = (s.get("project_ref") or "").strip() if s else ""
    host = (s.get("host") or "").strip() if s else ""
    region = (s.get("region") or "").strip() if s else ""

    # If anything essential is missing or still the placeholder, prompt for it.
    if not ref or ref == PLACEHOLDER_REF or not host:
        ref, host, region = prompt_connection()
        save_local_config(ref, host, region)

    return {"ref": ref, "region": region, "host": host}


# Use the TRANSACTION pooler (port 6543), not the session pooler (5432). The
# session pooler caps at 15 clients and a force-closed run leaks its slot until
# it times out; the transaction pooler only holds a server slot during each
# query/commit, so a long mostly-idle scrape never saturates it.
POOLER_PORT = 6543


def build_conn_string(cfg: dict, password: str) -> str:
    pw = urllib.parse.quote(password, safe="")
    return (
        f"postgresql://postgres.{cfg['ref']}:{pw}@{cfg['host']}:{POOLER_PORT}/postgres"
        f"?sslmode=require"
    )


def try_connect(conn_string: str):
    """Return a live connection or raise OperationalError on bad auth/unreachable."""
    conn = psycopg2.connect(conn_string, connect_timeout=15)
    # autocommit: every statement is its own transaction, so the transaction
    # pooler returns the server connection to the pool immediately and we never
    # sit idle-in-transaction between slow browser steps.
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SELECT 1")
        cur.fetchone()
    return conn


def read_saved_password() -> str | None:
    if not CREDENTIALS_PATH.exists():
        return None
    try:
        with CREDENTIALS_PATH.open("r", newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("password"):
                    return row["password"]
    except Exception as e:  # noqa: BLE001
        log(f"Could not read credentials.csv ({e}); will re-prompt.")
    return None


def save_password(password: str) -> None:
    with CREDENTIALS_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["key", "password"])
        w.writerow(["DATABASE_PASSWORD", password])
    log(f"Saved working password to {CREDENTIALS_PATH.name} (gitignored).")


def _is_max_clients(err: Exception) -> bool:
    s = str(err).lower()
    return "max clients reached" in s or "emaxconnsession" in s


def connect_with_pool_retry(conn_string: str, attempts: int = 6):
    """try_connect, but ride out a transient 'max clients reached' by waiting.

    Leaked pooler sessions from force-closed runs free up within a couple of
    minutes; rather than bounce the user back to the password prompt, we wait
    and retry. Auth failures are NOT retried — they re-raise immediately.
    """
    delay = 10
    for i in range(attempts):
        try:
            return try_connect(conn_string)
        except OperationalError as e:
            if _is_max_clients(e) and i < attempts - 1:
                log(f"Pooler is busy (max clients). Waiting {delay}s for slots "
                    f"to free up, then retrying ({i + 1}/{attempts - 1}) ...")
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise


def get_connection(cfg: dict):
    """
    First-run flow: try the saved password; if missing or wrong, prompt the user
    (hidden input), validate against Supabase, loop until it works, then persist.
    """
    env_url = normalized_env_database_url()
    if env_url:
        conn = connect_with_pool_retry(env_url)
        log("Database connection OK (DATABASE_URL).")
        return conn

    saved = read_saved_password()
    if saved:
        try:
            conn = connect_with_pool_retry(build_conn_string(cfg, saved))
            log("Database connection OK (saved password).")
            return conn
        except OperationalError as e:
            # Distinguish auth failure from transient network issues.
            if "password authentication failed" in str(e).lower():
                log("Saved password was rejected — please re-enter it.")
            else:
                log(f"Database unreachable with saved password: {e}")
                raise  # network problem — don't wipe a possibly-correct password

    # Interactive prompt loop (first run, or after an auth rejection).
    if not sys.stdin or not sys.stdin.isatty():
        log("ERROR: no saved/valid password and no interactive terminal to prompt. "
            "Run scraper/run-scraper.bat once manually to enter the password.")
        sys.exit(1)

    while True:
        password = getpass.getpass("Enter Supabase database password: ").strip()
        if not password:
            print("  (empty — try again)")
            continue
        try:
            conn = connect_with_pool_retry(build_conn_string(cfg, password))
            log("Database connection OK.")
            save_password(password)
            return conn
        except OperationalError as e:
            if "password authentication failed" in str(e).lower():
                print("  Wrong password. Please try again.")
            else:
                log(f"Cannot reach the database: {e}")
                print("  Connection error (not a password problem). Check your "
                      "network/config.ini, then try again.")


def normalized_env_database_url() -> str | None:
    """Return a psycopg2-compatible DATABASE_URL without logging credentials."""
    raw = (os.environ.get("DATABASE_URL") or "").strip()
    if not raw:
        return None

    password = os.environ.get("DATABASE_PASSWORD") or ""
    if "__PASSWORD__" in raw:
        if not password:
            raise OperationalError(
                "DATABASE_URL contains __PASSWORD__ but DATABASE_PASSWORD is missing"
            )
        raw = raw.replace("__PASSWORD__", urllib.parse.quote(password, safe=""))

    parsed = urllib.parse.urlsplit(raw)
    query = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in {"pgbouncer", "connection_limit", "pool_timeout"}
    ]
    return urllib.parse.urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            urllib.parse.urlencode(query),
            parsed.fragment,
        )
    )


# ----------------------------------------------------------------------------
# Image extraction — ported from src/lib/import/gmk-images.ts (incl. the
# main-gallery trim; without it, related-products carousels leak OTHER sets'
# images into this set's gallery).
# ----------------------------------------------------------------------------
_IMG_RE = re.compile(
    r"""(?:src|data-src|data-zoom-image|content)\s*=\s*["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']""",
    re.IGNORECASE,
)
_DROP_RE = re.compile(r"(logo|icon|sprite|payment|flag|placeholder)", re.IGNORECASE)

# Shopware renders "related products" / "customers also bought" carousels at the
# bottom of a product page, each carrying its own /media/ images. Those belong
# to OTHER sets and must not leak into this set's gallery. Cut the HTML at the
# first cross-selling marker so only the main product gallery remains.
_TRIM_MARKERS = [
    "cross-selling",
    "cross-sell",
    "cms-element-product-slider",
    "product-slider",
    "js-cross-selling",
    "related products",
    "customers also",
    "you may also",
]


def trim_to_main_gallery(html: str) -> str:
    low = html.lower()
    cut = len(html)
    for marker in _TRIM_MARKERS:
        idx = low.find(marker)
        if idx != -1 and idx < cut:
            cut = idx
    return html[:cut]


def extract_gmk_images(html: str) -> list[str]:
    # Only scan the main product gallery, not the related-products carousels.
    scope = trim_to_main_gallery(html)
    seen: list[str] = []
    for m in _IMG_RE.finditer(scope):
        u = m.group(1)
        if u.startswith("//"):
            u = "https:" + u
        if not re.match(r"^https?://", u):
            continue
        if "/media/" not in u:
            continue
        if _DROP_RE.search(u):
            continue
        if u not in seen:
            seen.append(u)
    return seen


def is_gmk_media(url: str) -> bool:
    """True for images scraped from gmk.net — the only ones a gallery rebuild
    may replace. KeycapLendar renders / admin-entered images are kept."""
    return "gmk.net" in url.lower()


def dedupe_keep_order(items) -> list[str]:
    out: list[str] = []
    for x in items:
        if x and x not in out:
            out.append(x)
    return out


# ----------------------------------------------------------------------------
# Browser helpers
# ----------------------------------------------------------------------------
def fetch_page_html(
    page: Page,
    url: str,
    *,
    scrapling: ScraplingClient | None = None,
    wait_selector: str | None = None,
    wait_ms: int = 0,
    protected: bool = False,
) -> str | None:
    """Use the existing browser first, then Scrapling's isolated stealth path.

    Keeping Playwright first preserves the saved cf_clearance profile. Scrapling
    becomes the recovery path when the page is blocked, times out, or the saved
    browser profile is no longer sufficient.
    """
    browser_error: Exception | None = None
    try:
        response = page.goto(
            url,
            wait_until="domcontentloaded",
            timeout=NAV_TIMEOUT_MS,
        )
        if wait_selector:
            try:
                page.wait_for_selector(wait_selector, timeout=8_000)
            except Exception:  # noqa: BLE001
                pass
        if wait_ms:
            page.wait_for_timeout(wait_ms)
        content = page.content()
        status = response.status if response is not None else None
        if content and not response_is_blocked(status, content):
            return content
        browser_error = RuntimeError(f"blocked response (status={status})")
    except Exception as exc:  # noqa: BLE001
        browser_error = exc

    if scrapling is not None and scrapling.available:
        content = scrapling.get_html(
            url,
            protected=protected,
            wait_selector=wait_selector,
            wait_ms=wait_ms,
        )
        if content:
            log(f"  Scrapling recovered page fetch ({url}).")
            return content

    if browser_error is not None:
        log(
            f"  page fetch failed ({url}): "
            f"{type(browser_error).__name__}: {browser_error}"
        )
    return None


def gmk_gallery(
    page: Page,
    url: str,
    scrapling: ScraplingClient | None = None,
) -> list[str]:
    try:
        content = fetch_page_html(
            page,
            url,
            scrapling=scrapling,
            wait_selector='img[src*="/media/"]',
            protected=True,
        )
        return extract_gmk_images(content or "")
    except Exception as e:  # noqa: BLE001
        log(f"  gmk gallery failed for {url}: {e}")
        return []


# ---- Price variant selection — ported from src/lib/import/prices.ts and
# src/lib/kit-variants.ts so BOTH scrapers store the same (BASE kit) price. ----

# Variant titles that are clearly NOT the keycap kit itself — GB listings often
# bundle add-ons (deskmats, samples, deposits...) as cheap variants.
_ADDON_VARIANT_RE = re.compile(
    r"(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain"
    r"|coin|tray|deposit|shipping|insurance|add[\s-]?on|extra)",
    re.IGNORECASE,
)

# Per-currency plausibility bounds for a GMK base kit. The lower bound admits
# CLEARANCE prices (released sets routinely sell off at USD 40-70); the upper
# bound rejects bundles/parse errors. MUST stay in sync with KIT_BOUNDS in
# src/lib/import/prices.ts and the purge window in scripts/db-setup.mjs — if
# this stores a price the deploy purge rejects, it gets wiped on every deploy.
_KIT_BOUNDS = {
    "USD": (30, 225),
    "EUR": (28, 210),
    "GBP": (24, 180),
    "AUD": (45, 345),
    "CAD": (41, 310),
    "SGD": (40, 310),
    "JPY": (4500, 34000),
    "KRW": (40000, 320000),
    "CNY": (215, 1650),
    "HKD": (235, 1800),
    "THB": (1075, 8100),
    "TWD": (965, 7300),
    # Chilean Peso — used by Fancy Customs (CL). 1 USD ≈ 960 CLP as of 2025.
    "CLP": (27_000, 210_000),
    # Indian Rupee — 1 USD ≈ 84 INR as of 2025. ~$30–$225 USD range.
    "INR": (2_500, 19_000),
    # Argentine Peso — used by Latamkeys. Volatile; bounds intentionally wide.
    "ARS": (30_000, 400_000),
    # Malaysian Ringgit — 1 USD ≈ 4.71 MYR as of 2025.
    "MYR": (140, 1100),
}

# Currencies the site's Currency table can convert (db-setup ensureCurrencies).
# Prices in anything else render as garbage (missing rate treated as 1, so
# 82,857 ARS displayed as $82,857 before ARS was supported) — never store them.
_SUPPORTED_CURRENCIES = {
    "USD", "SGD", "EUR", "GBP", "CAD", "AUD", "JPY", "CNY", "KRW", "MYR",
    "THB", "NZD", "HKD", "TWD", "SEK", "NOK", "DKK", "CHF", "PLN",
    "INR", "ARS", "CLP",
}


def classify_variant(title: str) -> str:
    """Mirror of classifyVariant in src/lib/kit-variants.ts — order matters."""
    if re.search(r"novelt", title, re.IGNORECASE):
        return "NOVELTIES"
    if re.search(r"space\s*bar", title, re.IGNORECASE):
        return "SPACEBARS"
    if re.search(r"alpha", title, re.IGNORECASE):
        return "ALPHA"
    if re.search(r"base", title, re.IGNORECASE):
        return "BASE"
    return "OTHERS"


def is_plausible_base_price(price: float, currency: str | None) -> bool:
    # Unknown currency → bound as USD (the fallback is always a western
    # vendor currency); currencies without bounds are not bounded.
    bounds = _KIT_BOUNDS.get(currency or "USD")
    if bounds is None:
        return True
    return bounds[0] <= price <= bounds[1]


def choose_kit_variant(variants: list[dict]) -> dict | None:
    """Pick the variant that is actually the BASE kit, NOT the cheapest one.

    Preference: BASE-classified variant > first remaining variant in display
    order (Shopify returns variants in display order; single-kit listings have
    one 'Default Title' variant, which classifies as OTHERS and is kept).

    Variants classified as a non-base STANDARD subkit (alphas, novelties,
    spacebars) are excluded outright — those are cheap add-on kits, never the
    base. When a listing carries ONLY subkits (no base kit on offer — e.g.
    Keygem listing a rainy-day GB with just novelties/spacebars), there is no
    base price to store, so return None and let the caller skip it rather than
    fall through to a misleading subkit price."""
    if not variants:
        return None
    non_addon = [v for v in variants if not _ADDON_VARIANT_RE.search(v["title"])]
    pool = non_addon if non_addon else variants
    # Drop labeled subkits so an absent base kit can't fall through to a cheap
    # alpha/novelty/spacebar variant; BASE and unlabeled OTHERS are retained.
    base_pool = [
        v for v in pool if classify_variant(v["title"]) in ("BASE", "OTHERS")
    ]
    if not base_pool:
        return None
    for v in base_pool:
        if classify_variant(v["title"]) == "BASE":
            return v
    return base_pool[0]


# Home country per currency — pins Shopify Markets' geo-localization to the
# store's own market so variant prices come back in the store's base currency,
# not converted to wherever this machine's IP geolocates (mirrors prices.ts).
_CURRENCY_HOME_COUNTRY = {
    "USD": "US", "SGD": "SG", "EUR": "DE", "GBP": "GB", "CAD": "CA",
    "AUD": "AU", "JPY": "JP", "KRW": "KR", "CNY": "CN", "HKD": "HK",
    "THB": "TH", "TWD": "TW", "MYR": "MY", "NZD": "NZ", "SEK": "SE",
    "NOK": "NO", "DKK": "DK", "CHF": "CH", "PLN": "PL",
}


def pinned_variant_id(product_url: str) -> str | None:
    """Vendor links often pin the exact kit variant (?variant=<id>) — that id
    is ground truth for which variant is the base kit (mirrors prices.ts)."""
    try:
        q = urllib.parse.urlsplit(product_url).query
        return (urllib.parse.parse_qs(q).get("variant") or [None])[0]
    except Exception:  # noqa: BLE001
        return None


def _parse_shopify_variants(raw_variants: list) -> list[dict]:
    """Shopify product.json variants → [{id, title, price}], invalid dropped."""
    out: list[dict] = []
    for v in raw_variants:
        try:
            p = float(v.get("price"))
        except (TypeError, ValueError):
            continue
        if p > 0:
            out.append({
                "id": str(v.get("id") or ""),
                "title": str(v.get("title") or ""),
                "price": p,
            })
    return out


def _pick_variant(variants: list[dict], pinned_id: str | None) -> dict | None:
    """Pinned ?variant=<id> beats any title heuristic (mirrors prices.ts)."""
    if pinned_id:
        for v in variants:
            if v["id"] == pinned_id:
                return v
    return choose_kit_variant(variants)


def _relevant_base_variants(
    variants: list[dict], chosen: dict, pinned_id: str | None
) -> list[dict]:
    if pinned_id:
        return [chosen]
    non_addon = [v for v in variants if not _ADDON_VARIANT_RE.search(v["title"])]
    pool = non_addon if non_addon else variants
    base = [v for v in pool if classify_variant(v["title"]) == "BASE"]
    return base if base else [chosen]


def _base_variants_in_stock(
    variants: list[dict],
    chosen: dict,
    pinned_id: str | None,
    availability_by_id: dict[str, bool],
) -> bool:
    """Use explicit Shopify stock for the selected/base variants when known."""
    relevant = _relevant_base_variants(variants, chosen, pinned_id)
    known = [
        availability_by_id[v["id"]]
        for v in relevant
        if v["id"] in availability_by_id
    ]
    return any(known) if known else True


def _structured_variant_stock_from_html(html: str) -> dict[str, bool]:
    """Extract per-variant availability from JSON-LD product offers."""
    result: dict[str, bool] = {}
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.DOTALL | re.IGNORECASE,
    )

    def walk(value) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        offers = value.get("offers") if isinstance(value.get("offers"), dict) else {}
        identity = " ".join(
            str(candidate)
            for candidate in (
                value.get("@id"),
                value.get("url"),
                offers.get("@id"),
                offers.get("url"),
            )
            if isinstance(candidate, str)
        )
        match = re.search(r"[?&]variant=(\d+)", identity)
        availability = (
            offers.get("availability")
            if isinstance(offers.get("availability"), str)
            else value.get("availability")
        )
        if match and isinstance(availability, str):
            result[match.group(1)] = not bool(
                re.search(r"outofstock|soldout|discontinued", availability, re.IGNORECASE)
            )
        for child in value.values():
            walk(child)

    for block in blocks:
        try:
            walk(json.loads(html_unescape(block.strip())))
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return result


def shopify_price(
    page: Page,
    product_url: str,
    vendor_currency: str | None,
    scrapling: ScraplingClient | None = None,
) -> dict | None:
    """Fetch Shopify price/stock while preserving application-specific rules.

    Scrapling's browser-impersonated HTTP path is attempted first. The saved
    Playwright browser remains the fallback for stores that require clearance
    cookies or JavaScript execution.
    """
    if "/products/" not in product_url:
        return None
    pinned_id = pinned_variant_id(product_url)
    clean = product_url.split("?")[0].split("#")[0].rstrip("/")
    browser_loaded = False

    def ensure_browser() -> None:
        nonlocal browser_loaded, clean
        if browser_loaded:
            return
        page.goto(product_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        final_url = page.url.split("?")[0].split("#")[0].rstrip("/")
        if "/products/" in final_url:
            clean = final_url
        browser_loaded = True

    def browser_json(url: str):
        ensure_browser()
        return page.evaluate(
            """async (u) => {
                try {
                    const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
                    if (!r.ok) return null;
                    return await r.json();
                } catch (e) { return null; }
            }""",
            url,
        )

    def fetched_json(
        url: str,
        *,
        cookies: dict[str, str] | None = None,
        browser_fallback: bool = True,
    ):
        if scrapling is not None:
            result = scrapling.get_json(
                url,
                headers={"Accept": "application/json"},
                cookies=cookies,
            )
            if result is not None:
                return result
        return browser_json(url) if browser_fallback else None

    try:
        # The cheap Scrapling HTTP path avoids opening a product page for most
        # public Shopify APIs. If it fails, Playwright navigates once, follows a
        # renamed handle, and all remaining browser fetches reuse that page.
        data = fetched_json(clean + ".json", browser_fallback=False)
        if not data or "product" not in data:
            ensure_browser()
            data = browser_json(clean + ".json")
        if not data or "product" not in data:
            return None

        origin = urllib.parse.urlsplit(clean)
        origin_url = f"{origin.scheme}://{origin.netloc}"

        # Reject pages where the product itself is an accessory / artisan —
        # the URL slug may coincidentally match a set name (e.g. ilumkb lists
        # a "Lavender x RAMA Artisan Keycap" at /products/gmk-lavender).
        product_title = str(data["product"].get("title") or "")
        if _ADDON_VARIANT_RE.search(product_title):
            log(f"  product title is an accessory — skipped ({product_url})")
            return None

        variants = _parse_shopify_variants(data["product"].get("variants") or [])
        chosen = _pick_variant(variants, pinned_id)
        if chosen is None:
            return None

        # product.json omits stock on some themes; product.js exposes an
        # explicit `available` flag for the same variant IDs.
        availability_by_id: dict[str, bool] = {}
        for variant in data["product"].get("variants") or []:
            available = variant.get("available")
            if isinstance(available, bool):
                availability_by_id[str(variant.get("id") or "")] = available
        stock_data = fetched_json(
            clean + ".js",
            browser_fallback=browser_loaded,
        )
        if stock_data:
            for variant in stock_data.get("variants") or []:
                available = variant.get("available")
                if isinstance(available, bool):
                    availability_by_id[str(variant.get("id") or "")] = available
        if not availability_by_id:
            relevant_ids = [
                variant["id"]
                for variant in _relevant_base_variants(variants, chosen, pinned_id)
            ]
            for variant_id in relevant_ids:
                variant_data = fetched_json(
                    f"{origin_url}/variants/{variant_id}.js",
                    browser_fallback=browser_loaded,
                )
                available = (
                    variant_data.get("available")
                    if isinstance(variant_data, dict)
                    else None
                )
                if isinstance(available, bool):
                    availability_by_id[str(variant_id)] = available
        if not availability_by_id:
            html = (
                scrapling.get_html(clean)
                if scrapling is not None and scrapling.available
                else None
            )
            if not html and browser_loaded:
                html = page.content()
            structured_stock = _structured_variant_stock_from_html(html or "")
            for variant_id, available in (structured_stock or {}).items():
                if isinstance(available, bool):
                    availability_by_id[str(variant_id)] = available
        if not availability_by_id:
            # Accuracy fallback: if every HTTP/structured source omitted stock,
            # load the real product page and retry the same authoritative
            # Shopify endpoints with its clearance/session cookies.
            ensure_browser()
            stock_data = browser_json(clean + ".js")
            if isinstance(stock_data, dict):
                for variant in stock_data.get("variants") or []:
                    available = variant.get("available")
                    if isinstance(available, bool):
                        availability_by_id[str(variant.get("id") or "")] = available
            if not availability_by_id:
                for variant in _relevant_base_variants(variants, chosen, pinned_id):
                    variant_data = browser_json(
                        f"{origin_url}/variants/{variant['id']}.js"
                    )
                    available = (
                        variant_data.get("available")
                        if isinstance(variant_data, dict)
                        else None
                    )
                    if isinstance(available, bool):
                        availability_by_id[variant["id"]] = available
            if not availability_by_id:
                availability_by_id.update(
                    _structured_variant_stock_from_html(page.content())
                )

        # Step 1: try the Shopify /meta.json endpoint (most reliable — this is
        # the store's PRIMARY currency that prices are denominated in).
        meta = fetched_json(
            origin_url + "/meta.json",
            browser_fallback=browser_loaded,
        )
        currency = meta.get("currency") if isinstance(meta, dict) else None
        if not currency and not browser_loaded:
            ensure_browser()
            meta = browser_json(origin_url + "/meta.json")
            currency = meta.get("currency") if isinstance(meta, dict) else None

        # Step 2: fall back to reading the currency FROM THE PAGE if meta.json
        # failed or returned nothing. Shopify stores expose the active currency
        # in several places we can read without JS-heavy interaction:
        #   a) The cart API (/cart.js) includes a currency field.
        #   b) Many themes render a visible currency selector whose selected
        #      option has a 3-letter currency code.
        #   c) The Shopify global variable window.Shopify.currency.active.
        # We try all three in order and take the first ISO-4217 match.
        if not currency:
            cart = fetched_json(
                origin_url + "/cart.js",
                browser_fallback=browser_loaded,
            )
            cart_currency = cart.get("currency") if isinstance(cart, dict) else None
            if isinstance(cart_currency, str) and re.fullmatch(
                r"[A-Z]{3}", cart_currency
            ):
                currency = cart_currency
        if not currency and browser_loaded:
            currency = page.evaluate(
                """() => {
                    try {
                        const sc = window.Shopify && window.Shopify.currency && window.Shopify.currency.active;
                        if (sc && /^[A-Z]{3}$/.test(sc)) return sc;
                    } catch (e) {}
                    // c) visible currency selector <option selected>
                    try {
                        const sel = document.querySelector(
                            '[data-currency-selector] option[selected], ' +
                            '.currency-selector option[selected], ' +
                            'select[name="currency"] option[selected], ' +
                            '[data-selected-currency]'
                        );
                        if (sel) {
                            const code = (sel.getAttribute('data-currency') ||
                                          sel.value || sel.textContent || '').trim().toUpperCase();
                            if (/^[A-Z]{3}$/.test(code)) return code;
                        }
                    } catch (e) {}
                    return null;
                }"""
            )

        # Pin the storefront to the DETECTED primary currency and re-fetch.
        # Shopify Markets geo-localizes .json prices to the requester's IP —
        # CannonKeys served this machine SGD numbers while meta.json said USD
        # (GMK BKRE $150 stored as 224). Pinning cart_currency + localization
        # to the store's own market makes the numbers match the label. The
        # vendor DB record is NOT used here: several records carry the wrong
        # currency (Yushakobo listed USD, store is JPY) and would relabel
        # genuine ¥20,000 numbers as "USD".
        if currency and currency in _CURRENCY_HOME_COUNTRY:
            try:
                cookies = {
                    "cart_currency": currency,
                    "localization": _CURRENCY_HOME_COUNTRY[currency],
                }
                repin = fetched_json(
                    clean + ".json",
                    cookies=cookies,
                    browser_fallback=False,
                )
                if not repin:
                    ensure_browser()
                    page.context.add_cookies([
                        {"name": "cart_currency", "value": currency, "url": origin_url},
                        {
                            "name": "localization",
                            "value": _CURRENCY_HOME_COUNTRY[currency],
                            "url": origin_url,
                        },
                    ])
                    repin = browser_json(clean + ".json")
                if repin and "product" in repin:
                    v2 = _parse_shopify_variants(repin["product"].get("variants") or [])
                    c2 = _pick_variant(v2, pinned_id)
                    if c2 is not None:
                        variants, chosen = v2, c2
            except Exception:  # noqa: BLE001
                pass

        # Fall back to the vendor's own currency (e.g. DeskHero = CAD), never
        # a blind USD default that inflates CA$88 into US$88.
        currency = currency or vendor_currency

        # Refuse currencies the site can't convert — they render as garbage.
        if currency and currency not in _SUPPORTED_CURRENCIES:
            log(f"  unsupported currency {currency} — skipped ({product_url})")
            return None

        if not is_plausible_base_price(chosen["price"], currency):
            log(f"  implausible kit price {chosen['price']} {currency} — skipped ({product_url})")
            return None

        in_stock = _base_variants_in_stock(
            variants, chosen, pinned_id, availability_by_id
        )
        # Stored variants carry title+price only (what the UI parses).
        variants = [{"title": v["title"], "price": v["price"]} for v in variants]
        return {
            "price": chosen["price"],
            "currency": currency,
            "variants": variants,
            "inStock": in_stock,
        }
    except Exception as e:  # noqa: BLE001
        log(f"  price fetch failed for {product_url}: {e}")
        return None


# ----------------------------------------------------------------------------
# DB candidate queries (mirror enrich-images.ts and prices.ts)
# ----------------------------------------------------------------------------
# Galleries are revisited (and rebuilt) once they're older than this, so a
# polluted gallery self-heals on its next visit instead of being skipped forever.
GALLERY_MAX_AGE_DAYS = 7

# Prices fresher than this are skipped — the nightly run shouldn't redo work.
PRICE_MAX_AGE_HOURS = 20

# Once a set reaches one of these statuses its gmk.net catalog page is frozen —
# the name, designer, description, and gallery never change again. The catalog
# and image passes skip these sets entirely; only prices keep rotating.
# IN_STOCK and SHIPPING are NOT terminal: extras sell out and shipments arrive,
# so those still get rechecked for the status transition.
TERMINAL_STATUSES = ("DELIVERED", "CANCELLED")


def fetch_frozen_catalog_slugs(conn) -> set[str]:
    """Slugs the catalog pass can skip: terminal status + gmk.net link present.

    The second condition matters — upsert_gmk_set is also what links the GMK
    vendor to imported sets, so a terminal set without that link still needs
    one visit.
    """
    sql = """
        SELECT gb.slug
          FROM "GroupBuy" gb
         WHERE gb.status::text = ANY(%s)
           AND EXISTS (
                SELECT 1 FROM "VendorKit" vk
                  JOIN "Kit" k ON k.id = vk."kitId"
                 WHERE k."groupBuyId" = gb.id
                   AND vk."productUrl" ILIKE '%%gmk.net%%')
    """
    with conn.cursor() as cur:
        cur.execute(sql, (list(TERMINAL_STATUSES),))
        return {row[0] for row in cur.fetchall()}


def fetch_image_candidates(conn, limit: int = 200) -> list[dict]:
    sql = """
        SELECT gb.id, gb.slug, gb."imageUrl", gb.images,
               (SELECT vk."productUrl"
                  FROM "VendorKit" vk
                  JOIN "Kit" k ON k.id = vk."kitId"
                 WHERE k."groupBuyId" = gb.id
                   AND vk."productUrl" ILIKE '%%gmk.net%%'
                 LIMIT 1) AS gmk_url
          FROM "GroupBuy" gb
         WHERE (gb."imagesUpdatedAt" IS NULL
                OR gb."imagesUpdatedAt" < now() - make_interval(days => %s))
           -- Released sets keep their gallery forever: once scraped
           -- successfully (stamped + non-empty), never revisit. Clearing
           -- imagesUpdatedAt forces a re-scrape if one is ever needed.
           AND NOT (gb.status::text = ANY(%s)
                    AND gb."imagesUpdatedAt" IS NOT NULL
                    AND COALESCE(array_length(gb.images, 1), 0) > 0)
           AND EXISTS (
                SELECT 1 FROM "VendorKit" vk
                  JOIN "Kit" k ON k.id = vk."kitId"
                 WHERE k."groupBuyId" = gb.id
                   AND vk."productUrl" ILIKE '%%gmk.net%%')
         ORDER BY gb."imagesUpdatedAt" ASC NULLS FIRST
         LIMIT %s
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (GALLERY_MAX_AGE_DAYS, list(TERMINAL_STATUSES), limit))
        return cur.fetchall()


def fetch_price_candidates(conn, limit: int = 500) -> list[dict]:
    # BASE kits only — buyers decide on the base kit and only base kit prices
    # are shown on the site. The vendor's currency rides along as the fallback
    # when a store blocks /meta.json.
    # GMK is the manufacturer, not a vendor: its rows only carry the gmk.net
    # URL for the catalog/image passes and must never be priced.
    sql = """
        SELECT vk.id, vk."productUrl", v.currency AS vendor_currency
          FROM "VendorKit" vk
          JOIN "Kit" k ON k.id = vk."kitId"
          JOIN "Vendor" v ON v.id = vk."vendorId"
         WHERE vk."productUrl" IS NOT NULL
           AND k.type = 'BASE'
           AND v.slug <> 'gmk'
           AND vk."productUrl" NOT ILIKE '%%gmk.net%%'
           AND (vk."priceSource" IS NULL OR vk."priceSource" <> 'MANUAL')
           AND (vk."priceUpdatedAt" IS NULL
                OR vk."priceUpdatedAt" < now() - make_interval(hours => %s))
         ORDER BY vk."priceUpdatedAt" ASC NULLS FIRST
         LIMIT %s
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (PRICE_MAX_AGE_HOURS, limit))
        return cur.fetchall()


# ----------------------------------------------------------------------------
# GMK.net catalog scraping
# GMK Electronic Maschinen (https://www.gmk.net/shop/en/) is the manufacturer
# of every GMK keycap set. Their Shopware webshop is the authoritative catalog.
# Two category URLs list all sets:
#   /shop/en/keycaps/      — all sets (in production, in stock, delivered)
#   /shop/en/group-buys/   — currently active / recent group buys
#
# Product URL pattern: https://www.gmk.net/shop/en/{slug}/{product-id}
# IDs currently use both legacy gmk10108 and newer fptk5113.0 forms.
# The slug matches our DB slug format exactly.
# ----------------------------------------------------------------------------

GMK_NET_ORIGIN = "https://www.gmk.net"
GMK_NET_CATALOG_URLS = [
    "https://www.gmk.net/shop/en/keycaps/",
    "https://www.gmk.net/shop/en/group-buys/",
]
GMK_VENDOR_SLUG = "gmk"
_GMK_PRODUCT_ID_RE = re.compile(
    r"^(?:gmk\d+|fptk\d+(?:\.\d+)?)$",
    re.IGNORECASE,
)

# Map URL path segment / breadcrumb keywords to GBStatus
_STATUS_MAP = [
    (re.compile(r"group[\s-]?buys?|active\s*gb", re.IGNORECASE), "ACTIVE_GB"),
    (re.compile(r"interest[\s-]?check", re.IGNORECASE), "INTEREST_CHECK"),
    (re.compile(r"in[\s-]?stock|extras?|available", re.IGNORECASE), "IN_STOCK"),
    (re.compile(r"in[\s-]?production|shipping|fulfil", re.IGNORECASE), "SHIPPING"),
]


def infer_status_from_text(text: str) -> str:
    for pattern, status in _STATUS_MAP:
        if pattern.search(text):
            return status
    return "DELIVERED"


def extract_gmk_slug_from_url(url: str) -> str | None:
    """Extract the set slug from a GMK.net product URL.

    URL pattern: https://www.gmk.net/shop/en/{slug}/{product-id}
    Returns the slug segment (e.g. 'gmk-cyl-ramune').
    """
    try:
        path = urllib.parse.urlsplit(url).path.rstrip("/")
        parts = [p for p in path.split("/") if p]
        # Find the slug: it follows 'en' and precedes the product id.
        for i, part in enumerate(parts):
            if part == "en" and i + 1 < len(parts):
                candidate = parts[i + 1]
                if _GMK_PRODUCT_ID_RE.match(candidate):
                    # The URL only has the product id after /en/ — unusual, skip
                    continue
                return candidate
    except Exception:
        pass
    return None


def _html_href(tag: str) -> str | None:
    match = re.search(r'\bhref\s*=\s*["\']([^"\']+)["\']', tag, re.IGNORECASE)
    return html_unescape(match.group(1).strip()) if match else None


def _catalog_links_from_html(html: str, current_url: str) -> tuple[list[str], str | None]:
    """Extract GMK product links and a pagination link without page JavaScript."""
    product_urls: list[str] = []
    next_url: str | None = None
    for tag in re.findall(r"<(?:a|link)\b[^>]*>", html, re.IGNORECASE):
        href = _html_href(tag)
        if not href:
            continue
        absolute = urllib.parse.urljoin(current_url, href)
        clean = absolute.split("#")[0].rstrip("/")
        if clean.startswith(GMK_NET_ORIGIN + "/shop/en/"):
            parts = clean.split("?")[0].rstrip("/").split("/")
            if len(parts) >= 6 and _GMK_PRODUCT_ID_RE.match(parts[-1]):
                product_url = clean.split("?")[0]
                if product_url not in product_urls:
                    product_urls.append(product_url)

        lowered_tag = tag.lower()
        if next_url is None and (
            re.search(r'\brel\s*=\s*["\'][^"\']*\bnext\b', tag, re.IGNORECASE)
            or re.search(
                r'\baria-label\s*=\s*["\'][^"\']*next\s+page',
                tag,
                re.IGNORECASE,
            )
            or "pagination-nav-next" in lowered_tag
            or "page-item next" in lowered_tag
        ):
            next_url = absolute
    return product_urls, next_url


def scrape_catalog_page_urls(
    page: Page,
    catalog_url: str,
    scrapling: ScraplingClient | None = None,
) -> list[str]:
    """Navigate a GMK.net catalog page (Shopware) and return all product URLs.

    Handles pagination via the 'Next page' button.
    """
    product_urls: list[str] = []
    visited: set[str] = set()
    current = catalog_url

    for page_num in range(1, 25):  # max 25 pages per category
        if current in visited:
            break
        visited.add(current)

        content = fetch_page_html(
            page,
            current,
            scrapling=scrapling,
            wait_selector="a[href]",
            protected=True,
        )
        if not content:
            log(f"  Catalog page {page_num} returned no usable HTML ({current}).")
            break

        links, next_url = _catalog_links_from_html(content, current)
        for link in links:
            if link not in product_urls:
                product_urls.append(link)

        if not next_url or str(next_url).split("?")[0].rstrip("/") in visited:
            break
        current = str(next_url)

    return product_urls


def scrape_gmk_product_metadata(
    page: Page,
    url: str,
    scrapling: ScraplingClient | None = None,
) -> dict | None:
    """Scrape a single GMK.net product page and return set metadata."""
    try:
        content = fetch_page_html(
            page,
            url,
            scrapling=scrapling,
            wait_selector="h1",
            protected=True,
        )
        if not content:
            return None

        # Try JSON-LD structured data (Shopware 6 often emits this)
        name = None
        description = ""
        jld_blocks = re.findall(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
            content, re.DOTALL | re.IGNORECASE
        )
        for block in jld_blocks:
            try:
                obj = json.loads(block.strip())
                if isinstance(obj, dict) and obj.get("@type") in ("Product", "ItemPage"):
                    name = (obj.get("name") or "").strip()
                    description = (obj.get("description") or "").strip()
                    break
            except (json.JSONDecodeError, ValueError):
                pass

        # Fallback: parse <h1> from HTML
        if not name:
            m = re.search(r"<h1[^>]*>(.*?)</h1>", content, re.DOTALL)
            if m:
                name = re.sub(r"<[^>]+>", "", m.group(1)).strip()

        if not name or not re.match(r"gmk\b", name, re.IGNORECASE):
            return None

        # Breadcrumb / category text for status inference
        breadcrumb = ""
        bc = re.search(
            r"(?:breadcrumb|navigation)[^>]*?>(.*?)</(?:nav|ol|ul)>",
            content, re.DOTALL | re.IGNORECASE
        )
        if bc:
            breadcrumb = re.sub(r"<[^>]+>", " ", bc.group(1)).strip()

        status = infer_status_from_text(url + " " + breadcrumb)

        # Extract slug from the URL (authoritative — GMK chose it)
        slug = extract_gmk_slug_from_url(url)
        if not slug:
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

        # Colorway: strip "GMK " (and optional "CYL ") prefix
        colorway = re.sub(r"^gmk\s+(?:cyl\s+)?", "", name, flags=re.IGNORECASE).strip()

        # Designer: look for "designed by X" in description
        designer = ""
        dm = re.search(
            r"(?:designed\s+by|designer\s*[:/])\s*([^\n<.,]{2,60})",
            description, re.IGNORECASE
        )
        if dm:
            designer = dm.group(1).strip()

        # Images from main gallery (reuse existing function)
        images = extract_gmk_images(content)

        return {
            "slug": slug,
            "name": name,
            "colorway": colorway,
            "designer": designer,
            "status": status,
            "description": description[:2000],
            "imageUrl": images[0] if images else None,
            "images": images[:10],
            "productUrl": url,
        }
    except Exception as e:
        log(f"  GMK.net product scrape failed ({url}): {e}")
        return None


def ensure_gmk_vendor(conn) -> str:
    """Return the GMK vendor id, creating it (with shipping zones) if needed."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "Vendor" WHERE slug = %s', (GMK_VENDOR_SLUG,))
        row = cur.fetchone()
        if row:
            vendor_id = row["id"]
        else:
            cur.execute("""
                INSERT INTO "Vendor"
                    (id, slug, name, region, country, currency, "websiteUrl", "logoUrl", "createdAt", "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, 'GMK', 'EU', 'DE', 'EUR', %s, NULL, now(), now())
                ON CONFLICT (slug) DO UPDATE SET "websiteUrl" = EXCLUDED."websiteUrl"
                RETURNING id
            """, (GMK_VENDOR_SLUG, GMK_NET_ORIGIN))
            vendor_id = cur.fetchone()["id"]

        # Without a ShippingZone row for the viewer's region the site hides
        # every priced listing of this vendor, so seed all destinations
        # (mirrors backfillShipping in scripts/db-setup.mjs; EU-origin rates).
        cur.execute("""
            INSERT INTO "ShippingZone"
                (id, "vendorId", "destinationRegion", "baseShippingCost", currency,
                 "estimatedDaysMin", "estimatedDaysMax", "shipsToRegion")
            SELECT gen_random_uuid()::text, %s, d.region::"Region",
                   d.cost, 'USD',
                   CASE WHEN d.region = 'EU' THEN 1 ELSE 2 END,
                   CASE WHEN d.region = 'EU' THEN 3 ELSE 5 END,
                   true
            FROM (VALUES
                ('EU', 8), ('UK', 10), ('US', 18), ('CA', 20),
                ('AU', 26), ('SG', 24), ('ASIA', 24), ('OTHER', 30)
            ) AS d(region, cost)
            ON CONFLICT ("vendorId", "destinationRegion") DO NOTHING
        """, (vendor_id,))
        return vendor_id


def upsert_gmk_set(conn, data: dict, vendor_id: str, *,
                   vk_currency: str = "EUR",
                   protect_terminal: bool = False) -> tuple:
    """Upsert a GroupBuy + BASE Kit + vendor link. Returns (gb_id, created).

    protect_terminal: don't overwrite a DELIVERED/CANCELLED status — used by
    sources (zFrontier regional GBs) that may still list a set as active
    after the worldwide run has shipped.
    """
    slug = data["slug"]

    # Cancelled sets never went to production — the site removes them entirely
    # (db-setup purges them on deploy), so don't (re)create them here either.
    if re.search(r"\bcancell?ed\b", data.get("name") or "", re.IGNORECASE) or "cancel" in slug:
        return None, False

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
        existing = cur.fetchone()

    if existing:
        gb_id = existing["id"]
        if protect_terminal:
            status_sql = ('CASE WHEN status::text = ANY(%s) THEN status '
                          'ELSE %s::"GBStatus" END')
            status_params = (list(TERMINAL_STATUSES), data["status"])
        else:
            status_sql = "%s"
            status_params = (data["status"],)
        # Update status and supplement blank fields; don't clobber manual edits.
        with conn.cursor() as cur:
            cur.execute(f"""
                UPDATE "GroupBuy" SET
                    status = {status_sql},
                    name = CASE WHEN (name IS NULL OR name = '') THEN %s ELSE name END,
                    designer = CASE WHEN (designer IS NULL OR designer = '') THEN %s ELSE designer END,
                    description = CASE WHEN (description IS NULL OR description = '') THEN %s ELSE description END,
                    "updatedAt" = now()
                WHERE slug = %s
            """, (*status_params, data["name"], data.get("designer") or "",
                  data.get("description") or "", slug))
        created = False
    else:
        images_list = data.get("images") or []
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO "GroupBuy"
                    (id, slug, name, colorway, designer, status,
                     "imageUrl", images, description, featured, "createdAt", "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, %s, %s, %s, %s,
                     %s, %s, %s, %s, now(), now())
                ON CONFLICT (slug) DO NOTHING
                RETURNING id
            """, (
                slug, data["name"], data.get("colorway") or "",
                data.get("designer") or "", data["status"],
                data.get("imageUrl"), images_list,
                data.get("description") or "",
                data["status"] == "ACTIVE_GB",
            ))
            row = cur.fetchone()
            if not row:
                cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
                row = cur.fetchone()
            gb_id = row["id"]

        # Create BASE kit
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO "Kit" (id, name, type, "groupBuyId")
                VALUES (gen_random_uuid()::text, 'Base Kit', 'BASE', %s)
                ON CONFLICT DO NOTHING
            """, (gb_id,))
        created = True

    # Store the gmk.net product page on a GMK VendorKit row. GMK is the
    # MANUFACTURER, not a vendor — this row is never priced or displayed; it
    # exists solely to carry the gmk.net URL for the image/catalog passes.
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            'SELECT id FROM "Kit" WHERE "groupBuyId" = %s AND type = \'BASE\' LIMIT 1',
            (gb_id,)
        )
        kit = cur.fetchone()
    if kit:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO "VendorKit"
                    (id, "kitId", "vendorId", "productUrl", "gbUrl", "inStock", currency, "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, %s, %s, %s, true, %s, now())
                ON CONFLICT ("kitId", "vendorId") DO UPDATE SET
                    "productUrl" = EXCLUDED."productUrl",
                    "gbUrl" = EXCLUDED."gbUrl",
                    "updatedAt" = now()
            """, (kit["id"], vendor_id, data["productUrl"], data["productUrl"],
                  vk_currency))

    return gb_id, created


def run_catalog(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    """Discover all GMK sets from gmk.net and upsert them to the DB.

    Walks /shop/en/keycaps/ and /shop/en/group-buys/, scrapes each product
    page for metadata, and links the GMK vendor. Runs FIRST so that image and
    price passes have complete set coverage.
    """
    stats = {"urls_found": 0, "sets_scraped": 0, "created": 0, "updated": 0,
             "skipped": 0, "failed": 0}
    log("Catalog pass: discovering GMK sets from gmk.net ...")

    gmk_vendor_id = ensure_gmk_vendor(conn)
    frozen_slugs = fetch_frozen_catalog_slugs(conn)
    log(f"  {len(frozen_slugs)} released set(s) already final — detail pages skipped.")
    catalog_page = context.new_page()
    detail_page = context.new_page()

    try:
        # Collect product URLs from both catalog categories
        all_urls: list[str] = []
        seen_urls: set[str] = set()
        for cat_url in GMK_NET_CATALOG_URLS:
            if now_ms() > deadline:
                log("Catalog pass: deadline reached during URL discovery.")
                stats["urls_found"] = len(all_urls)
                return stats
            urls = scrape_catalog_page_urls(catalog_page, cat_url, scrapling)
            for u in urls:
                if u not in seen_urls:
                    seen_urls.add(u)
                    all_urls.append(u)

        stats["urls_found"] = len(all_urls)
        log(f"  Found {len(all_urls)} product URL(s) across {len(GMK_NET_CATALOG_URLS)} categories.")

        for url in all_urls:
            if now_ms() > deadline:
                log("Catalog pass: deadline reached during product scraping.")
                break

            slug = extract_gmk_slug_from_url(url)
            if slug and slug in frozen_slugs:
                stats["skipped"] += 1
                continue

            metadata = scrape_gmk_product_metadata(detail_page, url, scrapling)
            if not metadata:
                stats["failed"] += 1
                continue

            stats["sets_scraped"] += 1
            _, created = upsert_gmk_set(conn, metadata, gmk_vendor_id)
            if created:
                stats["created"] += 1
                log(f"  + {metadata['name']} ({metadata['status']})")
            else:
                stats["updated"] += 1

    finally:
        catalog_page.close()
        detail_page.close()

    log(
        f"Catalog pass: urls={stats['urls_found']} scraped={stats['sets_scraped']} "
        f"created={stats['created']} updated={stats['updated']} "
        f"skipped={stats['skipped']} failed={stats['failed']}"
    )
    return stats


# ----------------------------------------------------------------------------
# zFrontier group-buy discovery
# zFrontier (https://www.zfrontier.com) runs the China-region group buys for
# most GMK sets. Their equipment collection filtered to tag=GMK and
# status=发车中 ("GB live") lists every GMK group buy currently running there:
#   /app/collection/keycap?tag=GMK&status=%E5%8F%91%E8%BD%A6%E4%B8%AD
# The page is a JS app with infinite scroll, so we render it in the browser,
# scroll until the card count stops growing, and read the cards from the DOM.
# ----------------------------------------------------------------------------

ZFRONTIER_ORIGIN = "https://www.zfrontier.com"
ZFRONTIER_GB_URL = (
    "https://www.zfrontier.com/app/collection/keycap"
    "?tag=GMK&status=%E5%8F%91%E8%BD%A6%E4%B8%AD"
)
ZFRONTIER_VENDOR_SLUG = "zfrontier"

_ZF_CARD_JS = """() => {
    const items = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href.startsWith('%s/app/')) continue;
        if (href.includes('/app/collection/')) continue;  // the list page itself
        const text = (a.innerText || '').trim();
        if (!/gmk/i.test(text)) continue;
        const clean = href.split('?')[0].replace(/\\/$/, '');
        if (seen.has(clean)) continue;
        seen.add(clean);
        const img = a.querySelector('img');
        items.push({
            url: clean,
            text,
            image: img ? (img.currentSrc || img.src || null) : null,
        });
    }
    return items;
}""" % ZFRONTIER_ORIGIN


def ensure_zfrontier_vendor(conn) -> str:
    """Return the zFrontier vendor id, creating it (with shipping zones) if needed."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "Vendor" WHERE slug = %s', (ZFRONTIER_VENDOR_SLUG,))
        row = cur.fetchone()
        if row:
            vendor_id = row["id"]
        else:
            # Region/currency mirror vendor-overrides.ts (ASIA / CN / USD).
            cur.execute("""
                INSERT INTO "Vendor"
                    (id, slug, name, region, country, currency, "websiteUrl", "logoUrl", "createdAt", "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, 'zFrontier', 'ASIA', 'CN', 'USD', %s, NULL, now(), now())
                ON CONFLICT (slug) DO UPDATE SET "websiteUrl" = EXCLUDED."websiteUrl"
                RETURNING id
            """, (ZFRONTIER_VENDOR_SLUG, ZFRONTIER_ORIGIN))
            vendor_id = cur.fetchone()["id"]

        cur.execute("""
            INSERT INTO "ShippingZone"
                (id, "vendorId", "destinationRegion", "baseShippingCost", currency,
                 "estimatedDaysMin", "estimatedDaysMax", "shipsToRegion")
            SELECT gen_random_uuid()::text, %s, d.region::"Region",
                   d.cost, 'USD',
                   CASE WHEN d.region = 'ASIA' THEN 2 ELSE 5 END,
                   CASE WHEN d.region = 'ASIA' THEN 5 ELSE 12 END,
                   true
            FROM (VALUES
                ('ASIA', 8), ('SG', 10), ('AU', 18), ('US', 20),
                ('CA', 22), ('EU', 22), ('UK', 22), ('OTHER', 25)
            ) AS d(region, cost)
            ON CONFLICT ("vendorId", "destinationRegion") DO NOTHING
        """, (vendor_id,))
        return vendor_id


def zfrontier_card_to_set(item: dict) -> dict | None:
    """Turn a collection card into upsert data, or None if unusable.

    Card text is multi-line (title, price, vendor tag …) — the title is the
    first line mentioning GMK. The slug comes from the title's ASCII words
    (CJK characters drop out), so 'GMK 厚乳 Pixel' and 'GMK Pixel' both land
    on 'gmk-pixel' and dedupe against the gmk.net catalog. Titles with no
    ASCII beyond 'GMK' can't be deduped reliably — skip those.
    """
    title = None
    for line in (item.get("text") or "").splitlines():
        line = line.strip()
        if re.search(r"\bgmk\b", line, re.IGNORECASE):
            title = line
            break
    if not title:
        return None

    slug = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    slug = re.sub(r"^gmk-(?:cyl-|mx-)", "gmk-", slug)
    if not slug.startswith("gmk"):
        slug = "gmk-" + slug
    if slug in ("gmk", "gmk-"):
        return None

    colorway = re.sub(r"^gmk\s+(?:cyl\s+)?", "", title, flags=re.IGNORECASE).strip()
    image = item.get("image")
    return {
        "slug": slug,
        "name": title,
        "colorway": colorway,
        "designer": "",
        "status": "ACTIVE_GB",
        "description": "",
        "imageUrl": image,
        "images": [image] if image else [],
        "productUrl": item["url"],
    }


def run_zfrontier(conn, context: BrowserContext, deadline: float) -> dict:
    """Discover GMK group buys currently running on zFrontier."""
    stats = {"cards": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}
    log("zFrontier pass: discovering active GMK group buys ...")

    vendor_id = ensure_zfrontier_vendor(conn)
    page = context.new_page()
    try:
        page.goto(ZFRONTIER_GB_URL, wait_until="domcontentloaded",
                  timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(3_000)  # let the JS app render the first batch

        # Infinite scroll until the card count stops growing.
        prev = -1
        items = []
        for _ in range(15):
            if now_ms() > deadline:
                log("zFrontier pass: deadline reached while scrolling.")
                break
            items = page.evaluate(_ZF_CARD_JS)
            if len(items) == prev:
                break
            prev = len(items)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1_500)

        stats["cards"] = len(items)
        log(f"  Found {len(items)} GMK card(s) on the live-GB collection.")

        for item in items:
            data = zfrontier_card_to_set(item)
            if not data:
                stats["skipped"] += 1
                continue
            try:
                _, created = upsert_gmk_set(
                    conn, data, vendor_id,
                    vk_currency="CNY", protect_terminal=True,
                )
            except Exception as e:
                log(f"  upsert failed ({data['slug']}): {e}")
                stats["failed"] += 1
                continue
            if created:
                stats["created"] += 1
                log(f"  + {data['name']} (ACTIVE_GB via zFrontier)")
            else:
                stats["updated"] += 1
    except Exception as e:
        log(f"zFrontier pass failed: {e}")
        stats["failed"] += 1
    finally:
        page.close()

    log(
        f"zFrontier pass: cards={stats['cards']} created={stats['created']} "
        f"updated={stats['updated']} skipped={stats['skipped']} failed={stats['failed']}"
    )
    return stats


# ----------------------------------------------------------------------------
# Passes
# ----------------------------------------------------------------------------
def run_images(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    stats = {"attempted": 0, "enriched": 0, "failed": 0}
    candidates = fetch_image_candidates(conn)
    log(f"Image pass: {len(candidates)} candidate set(s) with a gmk.net link.")
    page = context.new_page()
    try:
        for gb in candidates:
            if now_ms() > deadline:
                log("Image pass: time budget reached — stopping.")
                break
            gmk_url = gb.get("gmk_url")
            if not gmk_url:
                continue
            stats["attempted"] += 1
            gallery = gmk_gallery(page, gmk_url, scrapling)
            if not gallery:
                # Record the attempt so the rotation moves to the next set.
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "GroupBuy" SET "imagesUpdatedAt" = now() WHERE id = %s',
                        (gb["id"],),
                    )
                stats["failed"] += 1
                continue

            # REBUILD the gallery instead of merging: keep non-gmk images
            # (KeycapLendar render, manual entries) in order, then append the
            # freshly-scraped trimmed gmk gallery. Replacing the gmk images
            # wholesale means a previously polluted gallery self-heals here.
            existing = list(gb["images"] or ([gb["imageUrl"]] if gb["imageUrl"] else []))
            kept = [u for u in existing if not is_gmk_media(u)]
            rebuilt = dedupe_keep_order(kept + gallery)

            if rebuilt != existing:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "GroupBuy" SET images = %s, "imageUrl" = %s, '
                        '"imagesUpdatedAt" = now() WHERE id = %s',
                        (rebuilt, rebuilt[0], gb["id"]),
                    )
                stats["enriched"] += 1
                log(f"  {gb['slug']}: {len(existing)} -> {len(rebuilt)} images (rebuilt)")
            else:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "GroupBuy" SET "imagesUpdatedAt" = now() WHERE id = %s',
                        (gb["id"],),
                    )
    finally:
        page.close()
    return stats


def run_prices(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    stats = {"attempted": 0, "updated": 0, "failed": 0}
    candidates = fetch_price_candidates(conn)
    log(f"Price pass: {len(candidates)} vendor listing(s) to check.")
    page = context.new_page()
    try:
        for vk in candidates:
            if now_ms() > deadline:
                log("Price pass: time budget reached — stopping.")
                break
            stats["attempted"] += 1
            result = shopify_price(
                page,
                vk["productUrl"],
                vk.get("vendor_currency"),
                scrapling,
            )
            if result:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET price = %s, currency = %s, '
                        'variants = %s::jsonb, "inStock" = %s, '
                        '"priceUpdatedAt" = now(), "priceSource" = \'SCRAPED\' WHERE id = %s',
                        (
                            result["price"],
                            result["currency"],
                            json.dumps(result["variants"]),
                            result["inStock"],
                            vk["id"],
                        ),
                    )
                conn.commit()
                stats["updated"] += 1
            else:
                # Record the attempt so the oldest-first queue rotates onward.
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET "priceUpdatedAt" = now() WHERE id = %s',
                        (vk["id"],),
                    )
                conn.commit()
                stats["failed"] += 1
    finally:
        page.close()
    return stats


def now_ms() -> float:
    return datetime.now().timestamp() * 1000


# ----------------------------------------------------------------------------
# Keyboard group buys
#
# Moved off the Vercel cron: serverless fetches returned 0 because the stores'
# Cloudflare / datacenter-IP rules block them, and even when they fetched, the
# build-time migration couldn't reach the DB so the columns were missing. A
# REAL browser on the WorkSpace beats both. Keyboards change infrequently, so a
# nightly pass here is plenty — no need for a separate serverless schedule.
#
# Each product becomes a GroupBuy with productType='KEYBOARD'. The price lives
# directly on the row (single-vendor), unlike keycaps which fan out to many
# vendors via VendorKit. Admin-set layout/mount/material are never overwritten.
# ----------------------------------------------------------------------------
KEYBOARD_MIN_PRICE_USD = 300
KEYBOARD_BLOCKED_BRANDS = ("keychron", "nicepbt", "keykobo", "milkyway")

# Keycap profile prefixes / keycap-only brands in a product title → it's a
# keycap set, not a keyboard. "mw\b" catches Milkyway's MW abbreviation
# (e.g. "MW Gesha") only as a leading whole word, never mid-word.
_KB_KEYCAP_PROFILE_RE = re.compile(
    r"^\s*(?:gmk|sa\b|dcs\b|mtnu|kat\b|mt3\b|cyl\b|xda\b|mda\b|dsa\b|dss\b|kam\b|"
    r"nicepbt|keykobo|key[-\s]?kobo|milkyway|milky[-\s]?way|mw\b|"
    r"infinikey|keyreative|melgeek|sp[-\s]?sa)",
    re.I,
)

# Geekhack meta-threads to ignore (announcements, indexes, sticky posts)
_GH_META_RE = re.compile(
    r"^\*{2,}|list\s+of\s+(?:current|running|active)|"
    r"\[index\]|\[master\s+list\]|(?:board|forum)\s+rules|"
    r"stealing\s+my\s+identity|vendor\s+trust\s+and\s+safety",
    re.I,
)

# (id, displayName, [collection products.json urls], currency, region)
KEYBOARD_VENDORS = [
    ("nk", "NovelKeys",
     ["https://novelkeys.com/collections/keyboards/products.json"], "USD", "US"),
    ("ml", "MatrixLab",
     ["https://www.matrixlab.store/collections/group-buy/products.json"], "USD", "China"),
    ("pt", "Prototypist", [
        "https://prototypist.net/collections/live-group-buys/products.json",
        "https://prototypist.net/collections/pre-orders/products.json",
    ], "USD", "US"),
    ("klc", "KLC Playground", [
        "https://klc-playground.com/collections/extra-drop-from-group-buy/products.json",
        "https://klc-playground.com/collections/on-going-gb/products.json",
    ], "SGD", "Korea"),
    ("kt", "Ktechs", [
        "https://ktechs.store/collections/group-buy/products.json",
        "https://ktechs.store/collections/pre-order/products.json",
    ], "USD", "US"),
    ("pk", "Pantheon Keys",
     ["https://pantheonkeys.com/collections/ongoing-group-buys/products.json"], "SGD", "SG"),
    ("kbd", "KBDfans", [
        "https://kbdfans.com/collections/group-buy-live/products.json",
        "https://kbdfans.com/collections/group-buy-extra/products.json",
        "https://kbdfans.com/collections/pre-order/products.json",
    ], "USD", "China"),
    ("cc", "ClickClack",
     ["https://clickclack.io/collections/groupbuy/products.json"], "SGD", "SG"),
    ("ilu", "iLumKB", [
        "https://ilumkb.com/collections/live/products.json",
        "https://ilumkb.com/collections/pre-order-keycaps/products.json",
    ], "SGD", "SG"),
    ("ck", "CannonKeys", [
        "https://cannonkeys.com/collections/keyboard-group-buys/products.json",
        "https://cannonkeys.com/collections/keyboard-extras/products.json",
        "https://cannonkeys.com/collections/coming-soon/products.json",
    ], "USD", "US"),
    ("gn", "Geonworks", [
        "https://geon.works/collections/groupbuys/products.json",
    ], "USD", "Korea"),
    # Oblotzky Industries (EU GMK + keyboard store). Already scraped for keycap
    # pricing; this adds its keyboards. Store-wide products.json is used because
    # the keyboard classifier (price floor + keycap-profile filter) reliably
    # keeps boards like the TGR Jane V3 and drops their large GMK keycap catalog,
    # so we don't need to guess the exact collection handle.
    ("obl", "Oblotzky Industries",
     ["https://oblotzky.industries/products.json"], "EUR", "EU"),
]

_KB_LAYOUTS = [
    (re.compile(r"\b(100%|full[\s-]?size|fullsize)\b", re.I), "Full-size"),
    (re.compile(r"\b(tkl|80%|tenkeyless)\b", re.I), "TKL"),
    (re.compile(r"\b75%\b", re.I), "75%"),
    (re.compile(r"\b65%\b", re.I), "65%"),
    (re.compile(r"\b60%\b", re.I), "60%"),
    (re.compile(r"\b40%\b", re.I), "40%"),
    (re.compile(r"\b(alice|arisu)\b", re.I), "Alice/Arisu"),
    (re.compile(r"\bsplit\b", re.I), "Split"),
    (re.compile(r"\b(numpad|num\s?pad)\b", re.I), "Numpad"),
]
_KB_MOUNTS = [
    (re.compile(r"\bgasket\b", re.I), "Gasket"),
    (re.compile(r"\btop[\s-]?mount\b", re.I), "Top Mount"),
    (re.compile(r"\btray[\s-]?mount\b", re.I), "Tray Mount"),
    (re.compile(r"\bleaf[\s-]?spring\b", re.I), "Leaf Spring"),
    (re.compile(r"\bburger\b", re.I), "Burger"),
    (re.compile(r"\bplateless\b", re.I), "Plateless"),
]
_KB_MATERIALS = [
    (re.compile(r"\bpolycarbonate\b|\bpc\b", re.I), "Polycarbonate"),
    (re.compile(r"\balumini?u?m\b|\balu\b", re.I), "Aluminum"),
    (re.compile(r"\bacrylic\b", re.I), "Acrylic"),
    (re.compile(r"\bbrass\b", re.I), "PC + Brass"),
]


def ensure_keyboard_columns(conn) -> None:
    """Create keyboard columns if the build-time migration didn't (the Vercel
    build often can't reach the DB). All idempotent."""
    stmts = [
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "productType" text NOT NULL DEFAULT \'KEYCAPS\'',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "layout" text',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "material" text',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "mountingStyle" text',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "basePrice" double precision',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "priceCurrency" text',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "productUrl" text',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "vendorName" text',
        'ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "vendorRegion" text',
    ]
    with conn.cursor() as cur:
        for s in stmts:
            try:
                cur.execute(s)
            except Exception as e:
                log(f"  keyboard column ensure skipped: {e}")
    conn.commit()


def _kb_detect(patterns, text: str):
    for rx, val in patterns:
        if rx.search(text):
            return val
    return None


def _kb_tags(product: dict) -> list[str]:
    """Public /products.json returns tags as a list; be tolerant of a string."""
    t = product.get("tags")
    if isinstance(t, list):
        return [str(x).strip().lower() for x in t]
    return [s.strip().lower() for s in str(t or "").split(",")]


def kb_category_from_url(url: str):
    if re.search(r"extra.?drop|extras", url, re.I):
        return "extra-drop"
    if re.search(r"on.?going", url, re.I):
        return "ongoing-gb"
    if re.search(r"pre.?order|coming.?soon", url, re.I):
        return "pre-order"
    if re.search(r"group.?buy|live.?gb", url, re.I):
        return "group-buy"
    return None


def kb_detect_status(product: dict, category_hint) -> str:
    tags = _kb_tags(product)
    title = (product.get("title") or "").lower()
    any_available = any(v.get("available") for v in (product.get("variants") or []))

    if "interest-check" in tags or "ic" in tags or "interest check" in title:
        return "INTEREST_CHECK"
    if "shipping" in tags or "fulfillment" in tags or "shipping now" in title:
        return "SHIPPING"
    if "delivered" in tags or "complete" in tags or "fulfilled" in tags:
        return "DELIVERED"

    if category_hint == "extra-drop":
        return "IN_STOCK" if any_available else "DELIVERED"
    if category_hint in ("ongoing-gb", "group-buy"):
        return "ACTIVE_GB" if any_available else "DELIVERED"
    if category_hint == "pre-order":
        return "ACTIVE_GB" if any_available else "INTEREST_CHECK"

    return "ACTIVE_GB" if any_available else "DELIVERED"


def kb_detect_specs(product: dict) -> dict:
    body = re.sub(r"<[^>]+>", " ", product.get("body_html") or "")
    tags_text = ", ".join(_kb_tags(product))
    hay = " ".join([product.get("title") or "", tags_text, body])
    return {
        "layout": _kb_detect(_KB_LAYOUTS, hay),
        "mountingStyle": _kb_detect(_KB_MOUNTS, hay),
        "material": _kb_detect(_KB_MATERIALS, hay),
    }


def kb_variant_prices(product: dict) -> list[float]:
    out = []
    for v in (product.get("variants") or []):
        try:
            p = float(v.get("price"))
            if p > 0:
                out.append(p)
        except (TypeError, ValueError):
            pass
    return out


def kb_qualifies(product: dict) -> bool:
    """A keyboard if ANY variant clears the floor — cheap add-on variants
    (deposit, deskmat, extra PCB) must not drop the whole board."""
    return any(p >= KEYBOARD_MIN_PRICE_USD for p in kb_variant_prices(product))


def kb_base_price(product: dict):
    prices = kb_variant_prices(product)
    if not prices:
        return None
    real = [p for p in prices if p >= KEYBOARD_MIN_PRICE_USD]
    return min(real) if real else min(prices)


def kb_is_keycap(product: dict) -> bool:
    """A keycap set that slipped into a keyboard vendor collection (GMK, CYL, SA…)."""
    return bool(_KB_KEYCAP_PROFILE_RE.search(product.get("title", "")))


def kb_is_blocked(product: dict) -> bool:
    title = product.get("title", "")
    text = (f"{title} {product.get('tags', '')} "
            f"{product.get('product_type', '')}").lower()
    if any(b in text for b in KEYBOARD_BLOCKED_BRANDS):
        return True
    # Block keycap sets that appear in keyboard vendor collections (e.g. GMK CYL, SA, KAT…)
    if kb_is_keycap(product):
        return True
    return False


# ---------------------------------------------------------------------------
# GB end-date extraction — parses common date formats from product descriptions
# ---------------------------------------------------------------------------

_MONTH_NAMES = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?"
    r"|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
_ORD = r"(?:st|nd|rd|th)?"
_YEAR = r"20[2-9]\d"

# Each tuple: (compiled regex, group-extraction lambda that returns (year, mon, day) strings)
_DATE_PATTERNS: list[tuple] = [
    # "February 28, 2024" / "Feb 28 2024" / "Feb 28th, 2024"
    (re.compile(rf"({_MONTH_NAMES})\s+(\d{{1,2}}){_ORD}\s*,?\s*({_YEAR})", re.I),
     lambda m: (m.group(3), m.group(1), m.group(2))),
    # "28 February 2024" / "28th Feb 2024"
    (re.compile(rf"(\d{{1,2}}){_ORD}\s+({_MONTH_NAMES})\s+({_YEAR})", re.I),
     lambda m: (m.group(3), m.group(2), m.group(1))),
    # "2024-02-28" or "2024/02/28"
    (re.compile(rf"({_YEAR})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])"),
     lambda m: (m.group(1), m.group(2), m.group(3))),
    # "02/28/2024" (US format)
    (re.compile(rf"(0?[1-9]|1[0-2])/(0?[1-9]|[12]\d|3[01])/({_YEAR})"),
     lambda m: (m.group(3), m.group(1), m.group(2))),
    # "August 2026" / "Aug 2026" — month + year only; treat as 1st of month
    (re.compile(rf"({_MONTH_NAMES})\s+({_YEAR})", re.I),
     lambda m: (m.group(2), m.group(1), "1")),
]

_END_TRIGGERS = re.compile(
    r"(?:gb|group[\s\-]?buy|order(?:ing)?|pre[\s\-]?order)\s+(?:end[sd]?|clos(?:e[sd]?|ing)|deadline|until)"
    r"|end[sd]?\s+(?:date|on)|clos(?:e[sd]?\s+on|ing\s+(?:date|on))"
    r"|deadline|order\s+(?:close[sd]?|window\s+close[sd]?)"
    r"|estim(?:ated)?\s+(?:fulfillment|ship(?:ping)?|deliver(?:y|ies?)|dispatch)"
    r"|fulfillment\s*(?:date|:)|ships?\s+(?:in|by|around|approx)|ship\s*date",
    re.I,
)


def _try_parse_date(year_s: str, mon_s: str, day_s: str):
    """Try to build a date from the three string parts. month can be a name or number."""
    for fmt in ("%Y %B %d", "%Y %b %d", "%Y %m %d"):
        try:
            return datetime.strptime(f"{year_s} {mon_s.strip().title()} {day_s.zfill(2)}", fmt).date()
        except ValueError:
            pass
    return None


def kb_extract_gb_end_date(product: dict):
    """Return the GB end date parsed from body_html, or None."""
    body_raw = product.get("body_html") or ""
    body = re.sub(r"<[^>]+>", " ", body_raw)
    text = re.sub(r"\s+", " ", body)

    candidates = []

    # Preferred: dates found near end/close trigger words
    for tm in _END_TRIGGERS.finditer(text):
        snippet = text[tm.start(): tm.start() + 250]
        for rx, extractor in _DATE_PATTERNS:
            m = rx.search(snippet)
            if m:
                d = _try_parse_date(*extractor(m))
                if d:
                    candidates.append((0, d))  # priority 0 = high confidence
                    break

    # Fallback: any recognisable date in the whole description
    if not candidates:
        for rx, extractor in _DATE_PATTERNS:
            m = rx.search(text)
            if m:
                d = _try_parse_date(*extractor(m))
                if d:
                    candidates.append((1, d))
                    break

    if not candidates:
        return None

    # Return the highest-confidence soonest future date, else the nearest overall
    candidates.sort(key=lambda x: (x[0], abs((x[1] - datetime.now(timezone.utc).date()).days)))
    return candidates[0][1]


def fetch_collection_products(
    page: Page,
    products_json_url: str,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> list[dict]:
    """Navigate to the collection page (acquires cf_clearance) then fetch its
    paginated products.json. Scrapling's browser-TLS HTTP session is tried
    first; Playwright is opened only when the endpoint is blocked."""
    collection_page = products_json_url.replace("/products.json", "")
    products: list[dict] = []
    browser_loaded = False
    pg = 1
    while pg <= 10:
        if now_ms() > deadline:
            break
        url = f"{products_json_url}?limit=250&page={pg}"
        data = (
            scrapling.get_json(url, headers={"Accept": "application/json"})
            if scrapling is not None
            else None
        )
        if not data or "products" not in data:
            if not browser_loaded:
                try:
                    page.goto(
                        collection_page,
                        wait_until="domcontentloaded",
                        timeout=NAV_TIMEOUT_MS,
                    )
                    browser_loaded = True
                except Exception as e:
                    log(f"  collection nav failed ({collection_page}): {e}")
                    break
            data = page.evaluate(
                """async (u) => {
                    try {
                        const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
                        if (!r.ok) return null;
                        return await r.json();
                    } catch (e) { return null; }
                }""",
                url,
            )
        if not data or "products" not in data:
            break
        batch = data.get("products") or []
        products.extend(batch)
        if len(batch) < 250:
            break
        pg += 1
    return products


def upsert_keyboard(conn, vendor, product: dict, source_url: str) -> tuple:
    """Upsert one keyboard as a GroupBuy(productType='KEYBOARD')."""
    vid, vname, _urls, currency, region = vendor
    handle = product.get("handle") or ""
    if not handle:
        return None, False
    slug = f"{vid}-{handle}"[:120]

    category = kb_category_from_url(source_url)
    status = kb_detect_status(product, category)
    specs = kb_detect_specs(product)
    images = [img.get("src") for img in (product.get("images") or [])
              if img.get("src")][:8]
    image_url = images[0] if images else None
    base_price = kb_base_price(product)
    body = re.sub(r"<[^>]+>", " ", product.get("body_html") or "")
    description = re.sub(r"\s{2,}", " ", body).strip()[:1000]
    origin = urllib.parse.urlsplit(source_url)
    product_url = f"{origin.scheme}://{origin.netloc}/products/{handle}"
    title = product.get("title") or handle
    gb_end_date = kb_extract_gb_end_date(product)
    # Convert date → UTC midnight datetime for Postgres timestamptz
    gb_end_ts = (
        datetime.combine(gb_end_date, datetime.min.time()).replace(tzinfo=timezone.utc)
        if gb_end_date else None
    )

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
        existing = cur.fetchone()

    if existing:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE "GroupBuy" SET
                    name = %s,
                    status = %s::"GBStatus",
                    "productType" = 'KEYBOARD',
                    "imageUrl" = COALESCE(%s, "imageUrl"),
                    "basePrice" = %s,
                    "priceCurrency" = %s,
                    "productUrl" = %s,
                    "vendorName" = %s,
                    "vendorRegion" = %s,
                    layout = COALESCE(layout, %s),
                    material = COALESCE(material, %s),
                    "mountingStyle" = COALESCE("mountingStyle", %s),
                    "gbEnd" = COALESCE(%s, "gbEnd"),
                    "updatedAt" = now()
                WHERE slug = %s
            """, (title, status, image_url, base_price, currency, product_url,
                  vname, region, specs["layout"], specs["material"],
                  specs["mountingStyle"], gb_end_ts, slug))
        return existing["id"], False

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            INSERT INTO "GroupBuy"
                (id, slug, name, colorway, designer, status, "productType",
                 "imageUrl", images, description, featured,
                 "basePrice", "priceCurrency", "productUrl", "vendorName",
                 "vendorRegion", layout, material, "mountingStyle",
                 "gbEnd", "createdAt", "updatedAt")
            VALUES
                (gen_random_uuid()::text, %s, %s, '', %s, %s::"GBStatus",
                 'KEYBOARD', %s, %s, %s, false,
                 %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
            ON CONFLICT (slug) DO NOTHING
            RETURNING id
        """, (slug, title, vname, status, image_url, images,
              description or "", base_price, currency, product_url, vname,
              region, specs["layout"], specs["material"],
              specs["mountingStyle"], gb_end_ts))
        row = cur.fetchone()
    return (row["id"] if row else None), True


def run_keyboards(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    stats = {"fetched": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}
    log("Keyboard pass: scraping vendor stores (real browser) ...")
    ensure_keyboard_columns(conn)
    page = context.new_page()
    try:
        for vendor in KEYBOARD_VENDORS:
            if now_ms() > deadline:
                log("Keyboard pass: deadline reached — stopping.")
                break
            vid = vendor[0]
            urls = vendor[2]

            seen: dict = {}
            collected: list[tuple] = []
            for url in urls:
                if now_ms() > deadline:
                    break
                for p in fetch_collection_products(page, url, deadline, scrapling):
                    pid = p.get("id")
                    if pid not in seen:
                        seen[pid] = url
                        collected.append((p, url))

            # Self-heal: keycap sets that were previously scraped as KEYBOARD rows
            # (e.g. "GMK CYL Splash" from KBDfans) get reclassified to KEYCAPS so
            # they drop off the keyboards page on the next run.
            for p, _src in collected:
                if kb_is_keycap(p):
                    handle = p.get("handle") or ""
                    if not handle:
                        continue
                    kc_slug = f"{vid}-{handle}"[:120]
                    try:
                        with conn.cursor() as cur:
                            cur.execute(
                                'UPDATE "GroupBuy" SET "productType" = %s, "updatedAt" = now() '
                                'WHERE slug = %s AND "productType" = %s',
                                ("KEYCAPS", kc_slug, "KEYBOARD"),
                            )
                            if cur.rowcount:
                                stats["reclassified"] = stats.get("reclassified", 0) + 1
                        conn.commit()
                    except Exception:
                        conn.rollback()

            kept = [(p, src) for (p, src) in collected
                    if not kb_is_blocked(p) and kb_qualifies(p)]
            for p, src in kept:
                try:
                    _id, created = upsert_keyboard(conn, vendor, p, src)
                    conn.commit()
                    if created:
                        stats["created"] += 1
                    else:
                        stats["updated"] += 1
                    stats["fetched"] += 1
                except Exception as e:
                    conn.rollback()
                    if stats["failed"] == 0:
                        log(f"  {vid} first write error ({p.get('handle')}): {e}")
                    stats["failed"] += 1
            log(f"  {vid}: kept={len(kept)} of {len(collected)} "
                f"(created so far={stats['created']} updated={stats['updated']})")
    finally:
        page.close()
    log(f"Keyboard pass: fetched={stats['fetched']} created={stats['created']} "
        f"updated={stats['updated']} reclassified={stats.get('reclassified', 0)} "
        f"failed={stats['failed']}")
    return stats


# ----------------------------------------------------------------------------
# Lightning Keyboards build showcase (lightningkeyboards.com)
#
# A Squarespace portfolio of custom builds, paginated as /work-pt-1/ ../work-pt-N/.
# Each part page is a grid of build cards linking to /work-pt-N/<handle> detail
# pages (title + photo gallery). Parts freeze once the next one starts — only the
# latest part keeps gaining new builds. So:
#   - first run (no state): scrape every part from 1 upward until one is empty;
#   - later runs: re-scan only the latest known part for newly-added builds and
#     probe for the next part (N+1). Builds already scraped are skipped.
# State (latest part + scraped handles) lives in lk_seen.json. Each build becomes
# a GroupBuy(productType='KEYBOARD', status='DELIVERED') — a no-price showcase
# entry that's searchable and addable to a collection. Builds are NOT for sale,
# so vendorName credits the builder and productUrl points at the build page.
# ----------------------------------------------------------------------------
LK_BASE = "https://www.lightningkeyboards.com"
LK_MAX_PART_PROBE = 60  # safety ceiling when probing upward for new parts

# Anchor to a build detail page: /work-pt-<n>/<handle> (relative or absolute).
_LK_LINK_RE = re.compile(
    r'href="(?:https://www\.lightningkeyboards\.com)?(/work-pt-(\d+)/([^"#?\s]+))"',
    re.I,
)
_LK_IMG_RE = re.compile(r'https://images\.squarespace-cdn\.com/[^\s"\'<>)\\]+', re.I)
_LK_OG_TITLE_RE = re.compile(
    r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', re.I)
_LK_OG_IMG_RE = re.compile(
    r'<meta[^>]+property="og:image"[^>]+content="([^"]*)"', re.I)
_LK_OG_DESC_RE = re.compile(
    r'<meta[^>]+property="og:description"[^>]+content="([^"]*)"', re.I)


def lk_load_seen() -> dict:
    try:
        if LK_SEEN_PATH.exists():
            return json.loads(LK_SEEN_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def lk_save_seen(seen: dict) -> None:
    try:
        LK_SEEN_PATH.write_text(json.dumps(seen, indent=2), encoding="utf-8")
    except Exception as e:
        log(f"  lk_seen.json write failed: {e}")


def lk_list_builds(page: Page, part_n: int) -> list[dict]:
    """Return [{handle, url, part}] for build cards on /work-pt-<part_n>/.
    Empty list means the part doesn't exist (Squarespace 404s render as 200, so
    'no build links' is our end-of-pagination signal)."""
    url = f"{LK_BASE}/work-pt-{part_n}/"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(1200)  # let the lazy grid render
        markup = page.content()
    except Exception as e:
        log(f"  LK part {part_n} nav failed: {e}")
        return []

    out: list[dict] = []
    handles: set[str] = set()
    for m in _LK_LINK_RE.finditer(markup):
        full_path, part_str, handle = m.group(1), m.group(2), m.group(3)
        if int(part_str) != part_n:
            continue  # ignore sidebar/nav links pointing at other parts
        handle = handle.rstrip("/")
        if not handle or handle in handles:
            continue
        handles.add(handle)
        out.append({"handle": handle, "url": LK_BASE + full_path, "part": part_n})
    return out


def lk_scrape_build(page: Page, build: dict) -> dict | None:
    """Open a build detail page and pull its title, photo gallery, description."""
    try:
        page.goto(build["url"], wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(1200)
        # Scroll to force the lazy-loaded gallery to populate real image URLs.
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(900)
        markup = page.content()
    except Exception as e:
        log(f"  LK build nav failed ({build['handle']}): {e}")
        return None

    title = build["handle"].replace("-", " ").strip().title()
    mt = _LK_OG_TITLE_RE.search(markup)
    if mt and mt.group(1).strip():
        title = html_unescape(mt.group(1)).strip()

    images: list[str] = []
    bases: set[str] = set()

    def add_img(raw: str) -> None:
        base = raw.split("?")[0]
        if base and base not in bases:
            bases.add(base)
            images.append(base)  # base CDN URL is stable; query tokens expire

    mog = _LK_OG_IMG_RE.search(markup)
    if mog and mog.group(1).strip():
        add_img(mog.group(1).strip())
    for m in _LK_IMG_RE.finditer(markup):
        add_img(m.group(0))
        if len(images) >= 12:
            break

    if not images:
        return None  # no photos — almost certainly not a real build page

    desc = ""
    md = _LK_OG_DESC_RE.search(markup)
    if md and md.group(1).strip():
        desc = html_unescape(md.group(1)).strip()[:1000]

    return {
        "handle": build["handle"],
        "title": title[:200],
        "url": build["url"],
        "images": images,
        "description": desc,
    }


def lk_upsert_build(conn, build: dict) -> tuple:
    """Upsert one showcase build as GroupBuy(productType='KEYBOARD')."""
    slug = f"lk-{build['handle']}"[:120]
    image_url = build["images"][0]
    hay = f"{build['title']} {build['description']}"
    layout = _kb_detect(_KB_LAYOUTS, hay)
    material = _kb_detect(_KB_MATERIALS, hay)
    mount = _kb_detect(_KB_MOUNTS, hay)

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
        existing = cur.fetchone()

    if existing:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE "GroupBuy" SET
                    name = %s,
                    status = 'DELIVERED'::"GBStatus",
                    "productType" = 'KEYBOARD',
                    "imageUrl" = COALESCE(%s, "imageUrl"),
                    images = %s,
                    description = %s,
                    "productUrl" = %s,
                    "vendorName" = 'Lightning Keyboards',
                    layout = COALESCE(layout, %s),
                    material = COALESCE(material, %s),
                    "mountingStyle" = COALESCE("mountingStyle", %s),
                    "updatedAt" = now()
                WHERE slug = %s
            """, (build["title"], image_url, build["images"], build["description"],
                  build["url"], layout, material, mount, slug))
        return existing["id"], False

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            INSERT INTO "GroupBuy"
                (id, slug, name, colorway, designer, status, "productType",
                 "imageUrl", images, description, featured,
                 "productUrl", "vendorName", layout, material, "mountingStyle",
                 "createdAt", "updatedAt")
            VALUES
                (gen_random_uuid()::text, %s, %s, NULL, '', 'DELIVERED'::"GBStatus",
                 'KEYBOARD', %s, %s, %s, false,
                 %s, 'Lightning Keyboards', %s, %s, %s, now(), now())
            ON CONFLICT (slug) DO NOTHING
            RETURNING id
        """, (slug, build["title"], image_url, build["images"],
              build["description"], build["url"], layout, material, mount))
        row = cur.fetchone()
    return (row["id"] if row else None), True


def run_lightning(conn, context: BrowserContext, deadline: float) -> dict:
    stats = {"parts": 0, "new_builds": 0, "created": 0, "updated": 0,
             "skipped": 0, "failed": 0}
    log("Lightning Keyboards pass: scanning build showcase ...")
    ensure_keyboard_columns(conn)
    seen = lk_load_seen()
    scraped: set[str] = set(seen.get("scraped_builds", []))
    latest_part = int(seen.get("latest_part", 0) or 0)
    first_run = latest_part < 1

    page = context.new_page()
    try:
        # First run: discover every part from 1 up. Later: re-scan the latest
        # known part (it may have gained builds) and probe upward for new parts.
        # Part numbering may not start at 1 and may have gaps, so we don't stop
        # at the first missing part: we probe through a pre-start gap and only
        # stop once we've seen content AND then hit a few consecutive empties.
        GAP_LIMIT = 3       # consecutive empty parts after content → end of list
        PRESTART_LIMIT = 20  # give up if no part exists this low
        part_n = 1 if first_run else latest_part
        highest = latest_part
        found_any = not first_run
        misses = 0
        while part_n <= LK_MAX_PART_PROBE:
            if now_ms() > deadline:
                log("Lightning pass: deadline reached — resume on next run.")
                break
            builds = lk_list_builds(page, part_n)
            if not builds:
                misses += 1
                if found_any:
                    if misses >= GAP_LIMIT:
                        break  # past the last part
                elif part_n >= PRESTART_LIMIT:
                    break  # nothing found anywhere — give up
                part_n += 1
                continue
            misses = 0
            found_any = True
            stats["parts"] += 1
            highest = max(highest, part_n)
            for b in builds:
                if now_ms() > deadline:
                    break
                if b["handle"] in scraped:
                    stats["skipped"] += 1
                    continue
                detail = lk_scrape_build(page, b)
                if not detail:
                    stats["failed"] += 1
                    continue
                try:
                    _id, created = lk_upsert_build(conn, detail)
                    conn.commit()
                    scraped.add(b["handle"])
                    stats["new_builds"] += 1
                    if created:
                        stats["created"] += 1
                    else:
                        stats["updated"] += 1
                except Exception as e:
                    conn.rollback()
                    if stats["failed"] == 0:
                        log(f"  LK write error ({b['handle']}): {e}")
                    stats["failed"] += 1
            log(f"  LK part {part_n}: {len(builds)} cards "
                f"(new so far={stats['new_builds']} skipped={stats['skipped']})")
            part_n += 1

        seen["latest_part"] = highest
        seen["scraped_builds"] = sorted(scraped)
        lk_save_seen(seen)
    finally:
        page.close()
    log(f"Lightning pass: parts={stats['parts']} new_builds={stats['new_builds']} "
        f"created={stats['created']} updated={stats['updated']} "
        f"skipped={stats['skipped']} failed={stats['failed']}")
    return stats


# ----------------------------------------------------------------------------
# Geekhack board 70.0 scraper
# Reads the Group Buy listing, opens each thread that has a new last-post,
# extracts the first post (OP), and upserts into GroupBuy.
# Re-scrape guard: gh_seen.json tracks the last-post datetime we processed
# per topic so unchanged threads are skipped without opening them.
# ----------------------------------------------------------------------------

# Keycap profile keywords / keycap-only brands in thread titles → "KEYCAPS".
# MW = Milkyway's keycap abbreviation (e.g. "MW Gesha"); matched as a whole word.
_GH_KEYCAP_PROFILE = re.compile(
    r"\b(GMK|SA|DCS|MTNU|KAT|MT3|CYL|XDA|MDA|DSA|DSS|KAM|OG|SP[-\s]?SA|"
    r"Signature\s+Plastics|Cherry|PBT|NICEPBT|Keykobo|Key\s+Kobo|"
    r"Milkyway|Milky\s+Way|MW|Infinikey|Keyreative|Melgeek|KKB|PBS|SLK|EPBT|"
    r"EnjoyPBT)\b",
    re.I,
)

# Positive keyboard indicators — only these phrases flip the default to KEYBOARD
# (absent these, Geekhack threads default to KEYCAPS since most GBs are keycap sets)
_GH_KB_INDICATOR = re.compile(
    r"\b(keyboard|kbd\b|PCB|build\s+kit|typing\s+kit|FR4\s+plate|"
    r"TKL|HHKB|WKL|WK|Alice|Arisu|macropad|numpad|"
    r"TGR|Keycult|Norbaforce|Norbauer|Bakeneko|Meletrix|Geonworks|"
    r"Matrix\s*Lab|Rama\s+Works|Duck\s+(?:Orion|Octagon|Viper|Eagle)|"
    r"Hiney|Angry\s+Miao|Percent\s+Studio|Swagkeys)\b",
    re.I,
)
_GH_KB_LAYOUT = re.compile(r"(?<!\d)(?:40|45|50|60|65|75|80|96|100)%(?!\w)", re.I)
_GH_EXPLICIT_KEYCAP = re.compile(r"\b(?:key[\s-]?caps?|keysets?)\b", re.I)
_GH_ACCESSORY = re.compile(
    r"\b(stabili[sz]ers?|stabs?|wrist\s+rests?|keyboard\s+bags?|carrying\s+cases?|"
    r"cables?|deskmats?|case\s+foam|switch\s+films?|switches?\s+(?:gb|group\s+buy)|"
    r"linear\s+switc(?:h|hes)?|tactile\s+(?:switch|ec\s+domes?)|ec\s+domes?|"
    r"artisan\s+cases?)\b",
    re.I,
)
_GH_COMPONENT = re.compile(r"\b(replacement\s+PCBs?|PCBs?|plates?)\b", re.I)
_GH_STRONG_KB = re.compile(
    r"\b(keyboard|kbd\b|build\s+kit|typing\s+kit|macropad|numpad|"
    r"board|case|housing|topre|realforce|fc660c?|split|ortho|ergo)\b",
    re.I,
)
_GH_KB_SIZE_NAME = re.compile(
    r"\b(?:[a-z][a-z0-9_-]*)?(?:40|45|50|60|62|64|65|66|68|70|75|80|87|96|100|104|170)"
    r"(?:v\d+)?\b",
    re.I,
)
_GH_KB_MODEL = re.compile(
    r"\b(Rukia|BOCC|KIRA|Equilibrium|Nyawice|Jahre|KeyMaze|Metanoia|"
    r"Nooir|Klavier|Parabolica|Sonic170|Xte+|Sho66|Finn\s*60XT|RF[\s—-]*8X)\b",
    re.I,
)

# SMF date: "Mon, 01 June 2026, 17:13:33"
_GH_DATE_FMT = "%a, %d %B %Y, %H:%M:%S"
# Short SMF date: "Today at 17:13:33" or "Yesterday at …" — handled separately
_GH_DATE_SHORT = re.compile(r"(\d{1,2})\s+(\w+)\s+(\d{4}),?\s+(\d{2}:\d{2}:\d{2})", re.I)


def _gh_load_seen() -> dict:
    try:
        if GH_SEEN_PATH.exists():
            return json.loads(GH_SEEN_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _gh_save_seen(seen: dict) -> None:
    try:
        GH_SEEN_PATH.write_text(json.dumps(seen, indent=2), encoding="utf-8")
    except Exception as e:
        log(f"  gh_seen.json write failed: {e}")


def _gh_repair_topic_ids(conn) -> set[str]:
    """Topics that must be revisited even when their last-post date is unchanged."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT slug
                FROM "GroupBuy"
                WHERE slug ~ '^gh-[0-9]+$'
                  AND (
                    "imageUrl" IS NULL
                    OR COALESCE(cardinality(images), 0) = 0
                  )
                  AND (
                    "imagesUpdatedAt" IS NULL
                    OR "imagesUpdatedAt" < now() - interval '7 days'
                  )
                """
            )
            return {
                slug[3:]
                for (slug,) in cur.fetchall()
                if isinstance(slug, str) and slug.startswith("gh-")
            }
    except Exception as e:
        log(f"  Geekhack repair scan failed: {e}")
        return set()


def _gh_parse_last_post(text: str) -> datetime | None:
    """Parse SMF last-post date string into a datetime (UTC)."""
    text = text.strip()
    # Try "Mon, 01 June 2026, 17:13:33"
    try:
        return datetime.strptime(text, _GH_DATE_FMT).replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    # Try loose match: "01 June 2026, 17:13:33"
    m = _GH_DATE_SHORT.search(text)
    if m:
        try:
            return datetime.strptime(
                f"{m.group(1)} {m.group(2)} {m.group(3)} {m.group(4)}",
                "%d %B %Y %H:%M:%S",
            ).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def _gh_slugify(title: str) -> str:
    """Strip forum prefix/suffix noise then slugify a thread title."""
    # Remove [GB], [IC], [closed], trailing ' | note' sections
    t = re.sub(r"\[.*?\]", "", title)
    t = re.sub(r"\|.*", "", t)
    t = re.sub(r"\s*[-–]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*", "", t, flags=re.I)
    t = t.strip()
    slug = re.sub(r"[^\w\s-]", "", t.lower())
    slug = re.sub(r"\s+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:120]


def _gh_slug_variants(title: str) -> list[str]:
    base = _gh_slugify(title)
    variants = [base]
    # Also try without "CYL " — KeycapLendar sometimes omits the CYL profile prefix
    without_cyl = re.sub(r"\bcyl[-\s]+", "", base, flags=re.I).strip("-")
    if without_cyl != base and without_cyl:
        variants.append(without_cyl)
    return variants


def _gh_classify_title(title: str) -> str:
    if _GH_META_RE.search(title):
        return "ACCESSORY"
    strong_keyboard = bool(_GH_STRONG_KB.search(title))
    if strong_keyboard:
        return "KEYBOARD"
    if _GH_KEYCAP_PROFILE.search(title):
        return "KEYCAPS"
    if _GH_EXPLICIT_KEYCAP.search(title) and not strong_keyboard:
        return "KEYCAPS"
    if _GH_ACCESSORY.search(title):
        return "ACCESSORY"
    if _GH_COMPONENT.search(title) and not strong_keyboard:
        return "ACCESSORY"
    if (
        strong_keyboard
        or _GH_KB_INDICATOR.search(title)
        or _GH_KB_LAYOUT.search(title)
        or _GH_KB_SIZE_NAME.search(title)
        or _GH_KB_MODEL.search(title)
    ):
        return "KEYBOARD"
    return "UNKNOWN"


def _gh_detect_product_type(title: str) -> str:
    classified = _gh_classify_title(title)
    return "KEYCAPS" if classified == "UNKNOWN" else classified


def _gh_status(
    title: str,
    gb_end_date,
    last_post_dt: datetime | None = None,
) -> str:
    """Determine GBStatus from thread title and extracted end date."""
    from datetime import date as _date
    t = title.lower()
    if "[ic]" in t or "interest check" in t:
        return "INTEREST_CHECK"
    if re.search(r"\bin[\s-]?stock\b", t) or re.search(
        r"\bextras?\s+(?:are\s+)?(?:in\s+stock|available\s+now)\b", t
    ):
        return "IN_STOCK"
    completed = (
        "closed", "fulfilled", "delivered", "completed",
        "gb finish", "finished", "gb ended", "gb over",
        "group buy over", "100% sent", "100% shipped",
        "replacement keys shipped",
    )
    if any(marker in t for marker in completed) or re.search(r"\bcomplete\b", t):
        return "DELIVERED"
    post_gb = (
        "shipping", "fulfillment", "delivering", "final numbers",
        "production confirmed", "in production", "queue for production",
        "in the queue for production", "last day", "final weekend",
    )
    if any(marker in t for marker in post_gb):
        if last_post_dt and last_post_dt < datetime.now(timezone.utc) - timedelta(days=365):
            return "DELIVERED"
        return "SHIPPING"
    if gb_end_date and isinstance(gb_end_date, _date):
        if gb_end_date < _date.today() - timedelta(days=365):
            return "DELIVERED"
        if gb_end_date < _date.today():
            return "SHIPPING"
    if last_post_dt and last_post_dt < datetime.now(timezone.utc) - timedelta(days=365):
        return "DELIVERED"
    return "ACTIVE_GB"


def _update_gh_listing_metadata(
    conn,
    topic_id: str,
    title: str,
    last_post_dt: datetime | None,
) -> None:
    """Repair imported gh-* rows using the current board listing."""
    with conn.cursor() as cur:
        cur.execute(
            'SELECT "gbEnd" FROM "GroupBuy" WHERE slug = %s',
            (f"gh-{topic_id}",),
        )
        row = cur.fetchone()
    existing_end = row[0].date() if row and row[0] else None
    status = _gh_status(title, existing_end, last_post_dt)
    product_type = _gh_classify_title(title)
    with conn.cursor() as cur:
        if product_type == "UNKNOWN":
            cur.execute(
                """
                UPDATE "GroupBuy"
                SET status = %s::"GBStatus", "updatedAt" = now()
                WHERE slug = %s
                  AND status IS DISTINCT FROM %s::"GBStatus"
                """,
                (status, f"gh-{topic_id}", status),
            )
        else:
            cur.execute(
                """
                UPDATE "GroupBuy"
                SET status = %s::"GBStatus",
                    "productType" = %s,
                    "updatedAt" = now()
                WHERE slug = %s
                  AND (
                    status IS DISTINCT FROM %s::"GBStatus"
                    OR "productType" IS DISTINCT FROM %s
                  )
                """,
                (
                    status,
                    product_type,
                    f"gh-{topic_id}",
                    status,
                    product_type,
                ),
            )


def _gh_extract_images(html: str) -> list[str]:
    """Pull external image URLs from first-post HTML. Skips forum smileys/avatars."""
    imgs = re.findall(
        r'<img[^>]+(?:src|data-src|data-original|data-lazy-src)=["\']([^"\']+)["\']',
        html,
        re.I,
    )
    out = []
    for src in imgs:
        lsrc = src.lower()
        # Skip SMF smileys, avatars, icons, tiny images
        if any(x in lsrc for x in ("smiley", "emoji", "avatar", "icon", "16x16", "32x32")):
            continue
        # Keep only https:// external images
        if src.startswith("https://") and src not in out:
            out.append(src)
    return out[:8]


# JavaScript injected into the board listing page to extract thread rows
_GH_BOARD_JS = """
() => {
    const rows = Array.from(document.querySelectorAll(
        '#messageindex tbody tr, table.table_grid tbody tr'
    ));
    return rows.map(row => {
        const subj = row.querySelector(
            'td.subject a[href*="topic="], td[class*="subject"] a[href*="topic="]'
        );
        if (!subj) return null;
        const href = subj.href;
        const m = href.match(/topic=(\\d+)/);
        const lastEl = row.querySelector(
            'td.lastpost, td[class*="lastpost"]'
        );
        return {
            topic_id: m ? m[1] : null,
            title: subj.innerText.trim(),
            url: href.replace(/;start=\\d+$/, '.0'),
            last_post_text: lastEl ? lastEl.innerText.trim() : ''
        };
    }).filter(r => r && r.topic_id);
}
"""

# JavaScript to extract first-post data from a topic page
_GH_POST_JS = """
() => {
    // First post body — try multiple SMF selectors
    const selectors = [
        '#bodyarea .post .inner',
        '.postarea .post',
        '#forumposts div.post',
        '.postbody',
        '#msg_content',
    ];
    let el = null;
    for (const sel of selectors) {
        el = document.querySelector(sel);
        if (el) break;
    }
    if (!el) {
        // fallback: first .post div
        el = document.querySelector('.post');
    }
    const html = el ? el.innerHTML : '';
    const text = el ? el.innerText : '';
    const imgs = el ? Array.from(el.querySelectorAll('img')).flatMap(i => {
        const parentHref = i.closest('a')?.href;
        const linkedImage = parentHref && (
            /\\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(parentHref)
            || parentHref.includes('action=dlattach')
        ) ? parentHref : null;
        return [
            linkedImage,
            i.currentSrc,
            i.src,
            i.getAttribute('data-src'),
            i.getAttribute('data-original'),
            i.getAttribute('data-lazy-src'),
        ].filter(Boolean);
    }) : [];
    return { html, text, imgs };
}
"""


def _fetch_gh_board_page(page, url: str) -> list[dict]:
    """Navigate to one board listing page and return thread rows."""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(2_000)  # let JS render
    except Exception as e:
        log(f"  gh board page nav failed ({url}): {e}")
        return []
    try:
        rows = page.evaluate(_GH_BOARD_JS)
        return rows if isinstance(rows, list) else []
    except Exception as e:
        log(f"  gh board page extract failed: {e}")
        return []


def _fetch_gh_first_post(page, topic_url: str) -> dict | None:
    """Navigate to a topic and extract first-post content."""
    try:
        page.goto(topic_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(2_000)
    except Exception as e:
        log(f"  gh thread nav failed ({topic_url}): {e}")
        return None
    try:
        data = page.evaluate(_GH_POST_JS)
        if not data:
            return None
        return data
    except Exception as e:
        log(f"  gh thread extract failed: {e}")
        return None


def _upsert_gh_set(conn, data: dict) -> tuple[str | None, bool]:
    """
    Try to match an existing GroupBuy row by slug variants.
    If found: enrich description/gbEnd/productUrl cautiously (never overwrite
    vendor-set productUrl or admin-set specs).
    If not found: INSERT a new row with slug = gh-{topic_id}.
    Returns (id, was_created).
    """
    variants = data["slug_variants"]
    gh_slug = data["gh_slug"]
    product_type = data["product_type"]
    status = data["status"]
    description = (data.get("description") or "")[:2000]
    image_url = data.get("image_url")
    images = data.get("images") or []
    gb_end_ts = data.get("gb_end_ts")
    topic_url = data["topic_url"]
    title = data["title"]

    # Try to match existing row
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            'SELECT id, slug, "productUrl", description FROM "GroupBuy" WHERE slug = ANY(%s)',
            (variants,),
        )
        existing = cur.fetchone()

    if existing:
        # Enrich conservatively: only fill blank image fields; never overwrite
        # productUrl (that's the vendor buy-link). Re-running a previously empty
        # thread can therefore repair its card without replacing curated data.
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "GroupBuy" SET
                    description = CASE WHEN (description IS NULL OR description = '') THEN %s ELSE description END,
                    "gbEnd"     = COALESCE("gbEnd", %s),
                    "imageUrl" = CASE
                        WHEN ("imageUrl" IS NULL OR "imageUrl" = '') AND %s IS NOT NULL
                        THEN %s ELSE "imageUrl"
                    END,
                    images = CASE
                        WHEN COALESCE(cardinality(images), 0) = 0
                             AND cardinality(%s::text[]) > 0
                        THEN %s::text[] ELSE images
                    END,
                    "imagesUpdatedAt" = now(),
                    "updatedAt" = now()
                WHERE slug = %s
                """,
                (
                    description,
                    gb_end_ts,
                    image_url,
                    image_url,
                    images,
                    images,
                    existing["slug"],
                ),
            )
        return existing["id"], False

    # No match — create new row with gh- slug
    # Use gh- slug if no variant matches, else one of the variants
    insert_slug = gh_slug
    designer = ""
    # Attempt to extract designer hint from title: "by AuthorName" or "GMK Set | DesignerName"
    m = re.search(r"\|\s*(.+)$", title)
    if m:
        designer = m.group(1).strip()[:100]

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO "GroupBuy"
                (id, slug, name, colorway, designer, status, "productType",
                 "imageUrl", images, "imagesUpdatedAt", description, featured,
                 "productUrl", "gbEnd", "createdAt", "updatedAt")
            VALUES
                (gen_random_uuid()::text, %s, %s, '', %s, %s::"GBStatus", %s,
                 %s, %s, now(), %s, false,
                 %s, %s, now(), now())
            ON CONFLICT (slug) DO NOTHING
            RETURNING id
            """,
            (
                insert_slug, title, designer, status, product_type,
                image_url, images, description,
                topic_url, gb_end_ts,
            ),
        )
        row = cur.fetchone()
    return (row["id"] if row else None), True


def run_geekhack(
    conn,
    context: BrowserContext,
    deadline: float,
    *,
    min_year: int = GEEKHACK_MIN_YEAR,
    keyboards_only: bool = False,
    delay_min: float = GEEKHACK_DELAY_MIN,
    delay_max: float = GEEKHACK_DELAY_MAX,
) -> dict:
    """
    Scrape geekhack.org board 70.0 (Group Buys).
    - Paginates the listing until all threads with last-post >= min_year
      are collected (stops at the first page where all visible posts predate the cutoff).
    - For each thread: skip if last-post hasn't advanced since gh_seen.json.
    - Opens thread → reads first post → upserts GroupBuy.
    - Adds random 4–9s jitter between thread opens to be a polite guest.
    """
    stats = {
        "pages": 0, "threads_seen": 0, "skipped_old": 0,
        "skipped_non_keyboard": 0, "skipped_unchanged": 0,
        "scraped": 0, "created": 0, "updated": 0, "failed": 0,
    }
    scope = "keyboard history only" if keyboards_only else "all group buys"
    log(f"Geekhack pass: board 70.0 ({scope}, from {min_year}) …")

    seen = _gh_load_seen()
    repair_topic_ids = _gh_repair_topic_ids(conn)
    if repair_topic_ids:
        log(f"  Geekhack: forcing repair for {len(repair_topic_ids)} topic(s).")
    page = context.new_page()
    try:
        # ── 1. Collect thread listing ──────────────────────────────────────────
        all_threads: list[dict] = []
        start = 0
        while True:
            if now_ms() > deadline:
                log("  Geekhack: deadline reached during listing phase.")
                break
            # SMF encodes the topic offset as the suffix after the board id:
            # board=70.0, board=70.50, board=70.100, ...
            board_url = (
                f"https://geekhack.org/index.php?board=70.{start}"
                if start
                else GEEKHACK_BOARD_URL
            )
            rows = _fetch_gh_board_page(page, board_url)
            if not rows:
                break
            stats["pages"] += 1

            fresh = []
            old_count = 0
            for row in rows:
                lp = _gh_parse_last_post(row.get("last_post_text", ""))
                row["last_post_dt"] = lp
                if lp and lp.year >= min_year:
                    fresh.append(row)
                else:
                    old_count += 1

            all_threads.extend(fresh)
            stats["threads_seen"] += len(rows)
            stats["skipped_old"] += old_count

            # Pinned and malformed rows can be older than surrounding threads.
            # Stop only after a full page falls before the requested cutoff.
            if old_count == len(rows):
                break
            if stats["pages"] >= 250:
                log("  Geekhack: stopped at the 250-page safety limit.")
                break
            start += 50  # Geekhack's SMF board pages contain 50 topics

        log(f"  Geekhack: {len(all_threads)} threads from {stats['pages']} pages "
            f"(skipped {stats['skipped_old']} pre-{min_year})")

        # ── 2. Scrape each thread ──────────────────────────────────────────────
        for thread in all_threads:
            if now_ms() > deadline:
                log("  Geekhack: deadline reached during thread scrape.")
                break

            topic_id = str(thread.get("topic_id") or "")
            if not topic_id:
                continue

            thread_title = thread.get("title") or ""
            product_type = _gh_detect_product_type(thread_title)
            last_post_dt: datetime | None = thread.get("last_post_dt")
            last_post_iso = last_post_dt.isoformat() if last_post_dt else ""

            if keyboards_only:
                _update_gh_listing_metadata(conn, topic_id, thread_title, last_post_dt)

            if _GH_META_RE.search(thread_title):
                stats["skipped_old"] += 1  # reuse counter; these are noise
                continue
            if keyboards_only and product_type != "KEYBOARD":
                stats["skipped_non_keyboard"] += 1
                continue

            # Skip if last-post hasn't advanced
            if (
                topic_id not in repair_topic_ids
                and seen.get(topic_id)
                and last_post_iso
                and last_post_iso <= seen[topic_id]
            ):
                stats["skipped_unchanged"] += 1
                continue

            # Polite delay before opening each thread
            time.sleep(random.uniform(delay_min, delay_max))
            if now_ms() > deadline:
                break

            topic_url = thread.get("url") or ""
            if not topic_url:
                continue

            try:
                post = _fetch_gh_first_post(page, topic_url)
                if not post:
                    stats["failed"] += 1
                    continue

                title = thread.get("title") or ""
                body_html = post.get("html") or ""
                raw_images = post.get("imgs") or []
                image_html = body_html + "\n" + "\n".join(
                    f'<img src="{u}">' for u in raw_images
                )
                images = _gh_extract_images(image_html)

                # Re-use the same date extraction logic as the keyboard pass
                gb_end_date = kb_extract_gb_end_date({"body_html": body_html})
                gb_end_ts = (
                    datetime.combine(gb_end_date, datetime.min.time()).replace(tzinfo=timezone.utc)
                    if gb_end_date else None
                )

                status = _gh_status(title, gb_end_date, last_post_dt)

                # Clean description: strip HTML tags
                description = re.sub(r"<[^>]+>", " ", body_html)
                description = re.sub(r"\s{2,}", " ", description).strip()[:2000]

                upsert_data = {
                    "topic_id": topic_id,
                    "title": title,
                    "slug_variants": _gh_slug_variants(title),
                    "gh_slug": f"gh-{topic_id}",
                    "product_type": product_type,
                    "status": status,
                    "description": description,
                    "image_url": images[0] if images else None,
                    "images": images,
                    "gb_end_ts": gb_end_ts,
                    "topic_url": topic_url,
                }

                _id, created = _upsert_gh_set(conn, upsert_data)
                conn.commit()

                if created:
                    stats["created"] += 1
                else:
                    stats["updated"] += 1
                stats["scraped"] += 1

                # Update seen cache immediately so a crash doesn't re-scrape
                if last_post_iso:
                    seen[topic_id] = last_post_iso
                    _gh_save_seen(seen)

            except Exception as e:
                try:
                    conn.rollback()
                except Exception:
                    pass
                log(f"  gh topic {topic_id} error: {e}")
                stats["failed"] += 1

    finally:
        page.close()

    log(
        f"Geekhack: pages={stats['pages']} seen={stats['threads_seen']} "
        f"old={stats['skipped_old']} non_keyboard={stats['skipped_non_keyboard']} "
        f"unchanged={stats['skipped_unchanged']} "
        f"scraped={stats['scraped']} created={stats['created']} "
        f"updated={stats['updated']} failed={stats['failed']}"
    )
    return stats


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def parse_args():
    parser = argparse.ArgumentParser(description="GMK Tracker browser scraper")
    parser.add_argument(
        "--geekhack-backfill-year",
        type=int,
        metavar="YEAR",
        help=(
            "Run only a resumable Geekhack keyboard-history import, including "
            "threads whose last post is in YEAR or later."
        ),
    )
    parser.add_argument(
        "--budget-minutes",
        type=int,
        help="Maximum run time. Defaults to 30 normally and 240 for a backfill.",
    )
    parser.add_argument(
        "--lightning-only",
        action="store_true",
        help=(
            "Run only the Lightning Keyboards showcase scraper. Resumable — the "
            "large first-time backfill can be re-run safely until it completes."
        ),
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run Chromium without a visible window (used by manual GitHub Actions).",
    )
    parser.add_argument(
        "--no-scrapling",
        action="store_true",
        help="Disable Scrapling acquisition and use the legacy Playwright path only.",
    )
    return parser.parse_args()


def launch_scraper_context(playwright, *, headless: bool):
    launch_options = {
        "headless": headless,
        "viewport": None,
        "args": ["--start-maximized"],
        # A locked/corrupt profile should not stall the entire scheduled run
        # for Playwright's three-minute default before the clean retry.
        "timeout": 60_000,
    }

    try:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        probe = PROFILE_DIR / f".write-test-{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        log(f"Browser profile: {PROFILE_DIR}")
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            **launch_options,
        )
        return context, None
    except Exception as first_error:
        log(
            "Saved browser profile is unavailable "
            f"({type(first_error).__name__}: {first_error}). "
            "Retrying with a clean temporary profile."
        )

    temporary_profile = Path(
        tempfile.mkdtemp(prefix="gmk-tracker-browser-profile-")
    ).resolve()
    try:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(temporary_profile),
            **launch_options,
        )
        return context, temporary_profile
    except Exception:
        shutil.rmtree(temporary_profile, ignore_errors=True)
        raise


def main() -> int:
    global _LOG_FILE
    args = parse_args()
    if (
        args.geekhack_backfill_year is not None
        and not 2005 <= args.geekhack_backfill_year <= datetime.now().year
    ):
        print("ERROR: --geekhack-backfill-year must be between 2005 and the current year.")
        return 2
    if args.budget_minutes is not None and not 5 <= args.budget_minutes <= 720:
        print("ERROR: --budget-minutes must be between 5 and 720.")
        return 2

    LOG_DIR.mkdir(exist_ok=True)
    log_prefix = "geekhack_backfill" if args.geekhack_backfill_year else "scrape"
    _LOG_FILE = LOG_DIR / f"{log_prefix}_{datetime.now(SGT).strftime('%Y-%m-%d')}.log"
    cfg = {} if os.environ.get("DATABASE_URL") else load_config()

    try:
        conn = get_connection(cfg)
    except OperationalError as e:
        log(f"FATAL: could not connect to the database: {e}")
        return 1

    budget_minutes = args.budget_minutes or (
        240 if (args.geekhack_backfill_year or args.lightning_only) else 30
    )
    deadline = now_ms() + budget_minutes * 60 * 1000

    with ScraplingClient(
        headless=args.headless,
        logger=log,
        enabled=not args.no_scrapling,
    ) as scrapling:
        with sync_playwright() as p:
            context, temporary_profile = launch_scraper_context(
                p,
                headless=args.headless,
            )
            try:
                if args.geekhack_backfill_year:
                    log(
                        f"One-time Geekhack keyboard backfill from "
                        f"{args.geekhack_backfill_year}; budget={budget_minutes} minutes."
                    )
                    gh_stats = run_geekhack(
                        conn,
                        context,
                        deadline,
                        min_year=args.geekhack_backfill_year,
                        keyboards_only=True,
                        delay_min=2.0,
                        delay_max=4.0,
                    )
                elif args.lightning_only:
                    log(
                        f"Lightning Keyboards showcase scrape only; "
                        f"budget={budget_minutes} minutes."
                    )
                    lk_stats = run_lightning(conn, context, deadline)
                else:
                    # Catalog first so image + price passes have full set coverage
                    catalog_stats = run_catalog(conn, context, deadline, scrapling)
                    zf_stats = run_zfrontier(conn, context, deadline)
                    kb_stats = run_keyboards(conn, context, deadline, scrapling)
                    # Cap the nightly Lightning pass so a first-time full backfill
                    # can't starve the Geekhack/image/price passes that follow. The
                    # large initial backfill should be run once via --lightning-only;
                    # nightly only needs the small incremental scan of the latest
                    # part plus a probe for the next one.
                    lk_deadline = min(deadline, now_ms() + 6 * 60 * 1000)
                    lk_stats = run_lightning(conn, context, lk_deadline)
                    gh_stats = run_geekhack(conn, context, deadline)
                    img_stats = run_images(conn, context, deadline, scrapling)
                    price_stats = run_prices(conn, context, deadline, scrapling)
            finally:
                context.close()
                if temporary_profile is not None:
                    shutil.rmtree(temporary_profile, ignore_errors=True)

        if scrapling.available:
            log(f"Scrapling acquisition -> {scrapling.stats.summary()}")

    conn.close()
    if args.geekhack_backfill_year:
        log(
            f"Geekhack backfill -> pages={gh_stats['pages']} "
            f"keyboard_threads={gh_stats['scraped']} created={gh_stats['created']} "
            f"updated={gh_stats['updated']} unchanged={gh_stats['skipped_unchanged']} "
            f"non_keyboard={gh_stats['skipped_non_keyboard']} "
            f"old={gh_stats['skipped_old']} failed={gh_stats['failed']}"
        )
        log("Backfill done. Re-run the same command safely if the deadline was reached.")
        return 0

    if args.lightning_only:
        log(f"Lightning -> parts={lk_stats['parts']} new_builds={lk_stats['new_builds']} "
            f"created={lk_stats['created']} updated={lk_stats['updated']} "
            f"skipped={lk_stats['skipped']} failed={lk_stats['failed']}")
        log("Lightning backfill done. Re-run safely if the deadline was reached.")
        return 0

    log(f"Catalog -> urls={catalog_stats['urls_found']} "
        f"created={catalog_stats['created']} updated={catalog_stats['updated']} "
        f"skipped={catalog_stats['skipped']} failed={catalog_stats['failed']}")
    log(f"zFrontier -> cards={zf_stats['cards']} created={zf_stats['created']} "
        f"updated={zf_stats['updated']} skipped={zf_stats['skipped']} "
        f"failed={zf_stats['failed']}")
    log(f"Keyboards -> fetched={kb_stats['fetched']} created={kb_stats['created']} "
        f"updated={kb_stats['updated']} failed={kb_stats['failed']}")
    log(f"Lightning -> parts={lk_stats['parts']} new_builds={lk_stats['new_builds']} "
        f"created={lk_stats['created']} updated={lk_stats['updated']} "
        f"skipped={lk_stats['skipped']} failed={lk_stats['failed']}")
    log(f"Geekhack -> pages={gh_stats['pages']} scraped={gh_stats['scraped']} "
        f"created={gh_stats['created']} updated={gh_stats['updated']} "
        f"unchanged={gh_stats['skipped_unchanged']} old={gh_stats['skipped_old']} "
        f"failed={gh_stats['failed']}")
    log(f"Images  -> attempted={img_stats['attempted']} "
        f"enriched={img_stats['enriched']} failed={img_stats['failed']}")
    log(f"Prices  -> attempted={price_stats['attempted']} "
        f"updated={price_stats['updated']} failed={price_stats['failed']}")
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
