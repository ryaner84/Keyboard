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

# Standard GMK subkits that are never the base kit but aren't accessories, so
# the add-on filter above misses them. A numpad is a separate, cheaper kit;
# a numpad-only listing (e.g. Ktechs gmk-cyl-kitsune, reported as storing the
# numpad price as the base) must resolve to NO_BASE_KIT rather than keep it.
# Titles that ALSO say "base" are classified BASE before this filter runs, so
# a base kit that happens to bundle a numpad is still retained.
# Standard NON-BASE subkits that classify as OTHERS (not alphas/novelties/
# spacebars): numpads, 40s, accents, extensions, legends variants, icon and
# macro kits. Excluded from the base pool so a listing left with only these
# clears instead of storing a subkit price as the base. A title that also says
# "base" classifies BASE first and is kept (e.g. "Hiragana Base").
# Mirror of NONBASE_SUBKIT_RE in src/lib/kit-variants.ts — keep in sync.
_NONBASE_SUBKIT_RE = re.compile(
    r"num(?:ber)?\s*pad|\b40s\b|forties|accents?\b|extension|hiragana|katakana"
    r"|hangul|cyrillic|norde\b|nordic\b|\biso\b|\bicons?\b|\bmacro\b",
    re.IGNORECASE,
)

# Accessory words safe against PRODUCT titles (vs variant titles): no
# "extra" — a product titled "GMK Foo Extras" is a real base listing — and no
# "shipping"/"insurance" ("… Free Shipping" suffixes). Mirror of
# PRODUCT_ACCESSORY_RE in src/lib/kit-variants.ts — keep in sync.
# "leftover"/"child kit" catch the MULTI-SET clearance listing: one product
# whose variants are each a DIFFERENT set (NovelKeys "GMK Leftovers" holds 12,
# "GMK Child Kits" holds ~26). choose_kit_variant assumes every variant belongs
# to one set and takes the dearest as its base, so linking one of these would
# stamp an unrelated set's price onto whatever it matched. "badge" covers the
# keyboard-parts listings that share the same shape.
_TITLE_ACCESSORY_RE = re.compile(
    r"desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample"
    r"|keychain|coin|tray|deposit|add[\s-]?on|left\s?overs?|child\s*kits?"
    r"|\bbadges?\b",
    re.IGNORECASE,
)

# A catalog product whose RAW title names a subkit or accessory must never be
# linked as a set's VendorKit — normalize_set_name strips bracketed
# qualifiers, so "GMK Foo (Novelties)" would otherwise collide with the set
# name and overwrite the base product's URL; the price pass would then store
# the subkit's lone "Default Title" variant as the base price. "alphas" is
# plural-only so a set legitimately named "… Alpha" still links. Mirror of
# SUBKIT_PRODUCT_RE in src/lib/import/discovery.ts — keep in sync.
_SUBKIT_PRODUCT_RE = re.compile(
    r"novelt|space\s*bars?|\balphas\b|" + _NONBASE_SUBKIT_RE.pattern + r"|"
    + _TITLE_ACCESSORY_RE.pattern,
    re.IGNORECASE,
)

# Per-currency plausibility CEILING for a base kit. There is deliberately no
# floor any more: the dcs.wiki archive tracks accessory products as first-class
# sets (DCS Bae Addon, 6u bars, 10U Spacebars, 9009 Fix Kit …) whose real price
# is a few dollars, and a floor threw those away as "implausible". The minimum
# is kept at 0 only to reject a 0/negative parse result, which is never a real
# price. The upper bound stays: it rejects bundles and parse errors.
#
# THE MIRROR OF scripts/lib/kit-bounds.mjs, which is where the window is decided
# and where the reasoning for these numbers lives. prices.ts and db-setup.mjs
# both IMPORT that module; Python cannot, so this half copies it and
# `npm run test:kit-bounds` fails if the two tables ever disagree. That test
# exists because a ceiling too LOW does not fail loudly — it answers
# PRICE_REFUSED on a page it read and understood perfectly, and an unpriced row
# is hidden outright on a RELEASED set (norbauer.co's USD 230 keyset against the
# old ceiling of 225). Too low in the deploy PURGE is worse still: it wipes
# legitimate prices on every deploy, which is what blanked released-set pricing
# once before.
_KIT_BOUNDS = {
    "USD": (0, 300),
    "EUR": (0, 280),
    "GBP": (0, 240),
    "AUD": (0, 460),
    "CAD": (0, 415),
    "SGD": (0, 415),
    "JPY": (0, 45000),
    "KRW": (0, 425000),
    "CNY": (0, 2200),
    "HKD": (0, 2400),
    "THB": (0, 10800),
    "TWD": (0, 9700),
    # Chilean Peso — used by Fancy Customs (CL). 1 USD ≈ 960 CLP as of 2025.
    "CLP": (0, 280_000),
    # Indian Rupee — 1 USD ≈ 84 INR as of 2025.
    "INR": (0, 25_000),
    # Argentine Peso — used by Latamkeys. Volatile; bounds intentionally wide.
    "ARS": (0, 535_000),
    # Malaysian Ringgit — 1 USD ≈ 4.71 MYR as of 2025.
    "MYR": (0, 1470),
}

# Currencies the site's Currency table can convert (db-setup ensureCurrencies).
# Prices in anything else render as garbage (missing rate treated as 1, so
# 82,857 ARS displayed as $82,857 before ARS was supported) — never store them.
_SUPPORTED_CURRENCIES = {
    "USD", "SGD", "EUR", "GBP", "CAD", "AUD", "JPY", "CNY", "KRW", "MYR",
    "THB", "NZD", "HKD", "TWD", "SEK", "NOK", "DKK", "CHF", "PLN",
    "INR", "ARS", "CLP",
}


# Sentinel distinct from None. None means "couldn't read the listing this run"
# (blocked / transient) — the caller KEEPS the last good price. NO_BASE_KIT
# means "read the listing fine, but it carries no identifiable base kit (only
# subkits)" — the caller CLEARS the stored price. Without this split a listing
# that scrapes to a wrong subkit price never heals: the fix makes the picker
# return None, but None preserved the stale wrong number on every run. This is
# the root cause behind the recurring Keygem rainy-day-r2 reports.
NO_BASE_KIT = "NO_BASE_KIT"

# A third answer, and the one that was missing. DEAD_LINK means the STORE said
# the page does not exist (404/410). It clears the stored price exactly like
# NO_BASE_KIT, but it is a different fact: folded into NO_BASE_KIT it stamped
# priceSource='SCRAPED', the same mark a live page with only add-on kits gets,
# so a store whose products were all removed read as a pricing backlog and the
# publishing report sent the owner to refresh-prices — the one pass that can
# never fix a page that is gone.
#
# Mirror of scripts/lib/link-health.mjs, which the TypeScript price pass
# imports directly. `npm run test:link-health` parses this file and fails if
# the two copies disagree — the price pass is written twice (run_prices here,
# refreshPrices in prices.ts) and a fix to one is only half a fix.
DEAD_LINK = "DEAD_LINK"

# The fourth and fifth answers, and the two that were still hiding inside None.
# Both mean the page was FETCHED and the fault is on THIS side of the
# connection, so filing them as "couldn't read the listing" was a lie: the row
# never counted as read (priceSource stayed NULL), so the publishing report told
# the owner to relink or retire a store that is live and selling the set;
# linkFailures climbed on a page that answered perfectly, so the row was demoted
# to the 14-day dead-link cadence; and nothing named the repair, which is code
# or config here rather than another scrape.
#
#   PRICE_REFUSED    the product data parsed and the number was rejected by
#                    this site's rules — outside _KIT_BOUNDS, or a currency the
#                    Currency table cannot convert. norbauer.co quotes USD 230
#                    for a DSA base kit against a USD ceiling that stood at 225
#                    (raised to 300 once that was measured);
#                    rationalkeys.com.tr prices its JSON-LD Product in TRY.
#   NO_PRODUCT_DATA  a 200 carrying no markup any parser path knows: Drop's
#                    /buy/ SPA, funkeys' custom storefront, the 114-byte
#                    placeholder captus.io and kingly-keys.xyz now serve.
#
# Neither clears a stored price: the refusal is about the number just read, and
# a page with no markup says nothing about the last good one.
PRICE_REFUSED = "PRICE_REFUSED"
NO_PRODUCT_DATA = "NO_PRODUCT_DATA"

# What priceSource records once a page has been READ. Mirror of
# PRICE_SOURCE_REFUSED / PRICE_SOURCE_UNPARSED in scripts/lib/link-health.mjs.
PRICE_SOURCE_REFUSED = "REFUSED"
PRICE_SOURCE_UNPARSED = "UNPARSED"

# HTTP statuses that mean the listing is gone rather than blocked.
DEAD_LINK_STATUSES = (404, 410)

# Consecutive unreadable attempts before a link is backed off. One attempt per
# row per nightly run, so six is about a week of "this never once answered" —
# out of reach of a Cloudflare block or a bad night, short enough that a closed
# store stops costing the run within days.
DEAD_LINK_FAILURE_THRESHOLD = 6

# How long a backed-off row waits between attempts. A back-off, never a
# retirement: the row keeps its place in the queue and the first read that gets
# through resets both columns, so a store that comes back needs no help.
DEAD_LINK_RECHECK_HOURS = 24 * 14


def is_gone_redirect(request_url, final_url) -> bool:
    """True when a request was answered by a storefront's FRONT DOOR.

    The other way a store says "gone", and the commonest one: Shopify sends a
    deleted product to `/` rather than 404ing it (kono.store does that for all
    44 of its tracked listings), and an acquired shop 301s its whole domain to
    the buyer's home page (ashkeebs.com → kineticlabs.com, 38 listings). The
    browser follows the hop, so the pass only ever saw a 200 on a page that is
    not the listing and kept re-fetching it — only a 404/410 clears a price.

    Only the ROOT counts: a redirect onto another product (a renamed handle) or
    onto a collection says nothing about this listing, and a request that
    STARTED at the root was not redirected off anything. Mirror of
    isGoneRedirect in scripts/lib/link-health.mjs.
    """

    def front_door(url):
        try:
            parts = urllib.parse.urlsplit(str(url or ""))
        except ValueError:
            return None
        if not parts.scheme or not parts.netloc:
            return None
        return parts.path.rstrip("/") == ""

    origin = front_door(request_url)
    target = front_door(final_url)
    if origin is None or target is None:
        return False
    return target and not origin


# The network-level answers that mean the HOST itself is gone — NXDOMAIN, in
# each spelling this pass can be handed one: Chromium (Playwright's page.goto)
# says ERR_NAME_NOT_RESOLVED, a Python socket.gaierror carries the libc string,
# and the Node halves see ENOTFOUND. Everything NOT here is the point: EAI_AGAIN
# is a temporary resolver failure, a refused or timed-out connection is a host
# that exists, and a certificate error is a live site with a lapsed cert — all
# blocks, and a block may never hide a listing. Mirror of
# GONE_HOST_ERROR_MARKERS in scripts/lib/link-health.mjs.
GONE_HOST_ERROR_MARKERS = (
    "ENOTFOUND",
    "EAI_NONAME",
    "ERR_NAME_NOT_RESOLVED",
    "Name or service not known",
    "nodename nor servname",
)


def is_gone_host_error(exc) -> bool:
    """True when a navigation failed because the host does not exist.

    The third way a store says "gone", after the 404 and the front-door
    redirect, and the only one with no HTTP answer at all — which is why it was
    invisible: the browser raises, the pass logs "fetch error", and the row is
    filed under the same None a Cloudflare block gives. NXDOMAIN is as
    definitive as a 404 (there is no server to ask) and just as self-healing,
    since next_link_health clears deadSince on the first read that gets
    through. Mirror of isGoneHostError in scripts/lib/link-health.mjs.
    """
    if exc is None:
        return False
    text = f"{type(exc).__name__}: {exc}"
    cause = getattr(exc, "__cause__", None) or getattr(exc, "__context__", None)
    if cause is not None:
        text += f"\n{type(cause).__name__}: {cause}"
    return any(marker in text for marker in GONE_HOST_ERROR_MARKERS)


def next_link_health(link_failures, dead_since, outcome, now=None):
    """Link-health columns after one price attempt. Pure — the caller writes.

    `outcome` is "PRICED", "NO_BASE_KIT", "PRICE_REFUSED", "NO_PRODUCT_DATA",
    "GONE" or "UNREADABLE". PRICED, NO_BASE_KIT and PRICE_REFUSED are all
    successful READS: treating NO_BASE_KIT as a failure would flag every store
    that legitimately sells only add-on kits, and treating PRICE_REFUSED as one
    flags a store that is live, readable and quoting a real number this site
    simply won't store — a fault on THIS side, never evidence about the link.
    NO_PRODUCT_DATA is deliberately NOT a read here: an unparseable 200 and a
    bot check served as a 200 are indistinguishable from here, which is the
    same reason linkFailures exists at all.
    Mirror of nextLinkHealth in scripts/lib/link-health.mjs.
    """
    failures = int(link_failures or 0)
    if outcome in ("PRICED", "NO_BASE_KIT", "PRICE_REFUSED"):
        return 0, None
    if outcome == "GONE":
        # Keep the FIRST moment it was seen gone: how long the store has been
        # broken is what decides relink-or-retire.
        return failures + 1, dead_since or (now or datetime.now())
    return failures + 1, dead_since


def ensure_link_health_columns(conn) -> None:
    """Create the link-health columns if the build-time migration didn't — the
    nightly run happens whether or not a deploy has reached the DB since."""
    stmts = [
        'ALTER TABLE "VendorKit" ADD COLUMN IF NOT EXISTS '
        '"linkFailures" integer NOT NULL DEFAULT 0',
        'ALTER TABLE "VendorKit" ADD COLUMN IF NOT EXISTS "deadSince" timestamp(3)',
    ]
    with conn.cursor() as cur:
        for s in stmts:
            try:
                cur.execute(s)
            except Exception as e:
                log(f"  link-health column ensure skipped: {e}")
    conn.commit()


# Kits a bundle can be bundled WITH. Reuses the non-base subkit vocabulary and
# adds the three standard kit names classify_variant tests for directly.
_BUNDLE_EXTRA_RE = re.compile(
    r"novelt|ノベルティ|space\s*bar|スペースバー|alpha|アルファ|"
    + _NONBASE_SUBKIT_RE.pattern,
    re.IGNORECASE,
)


def classify_variant(title: str) -> str:
    """Mirror of classifyVariant in src/lib/kit-variants.ts — order matters.

    The Japanese alternates are REQUIRED here, not just in the TS mirror: this
    scraper is the one that actually reaches Yushakobo (real browser), and
    without them a JP-titled subkit (ノベルティ) classified OTHERS and could be
    stored as the base price when the base kit had sold out."""
    # BUNDLE before the subkit tests: "Base + Novelties" would otherwise match
    # `novelt` and be filed as a novelty kit, so a bundle-only listing yielded
    # no base candidate and stored nothing.
    #
    # A joiner alone is NOT enough. Oblotzky sells "Teal & White Base" and
    # Yushakobo "Two Baseセット（Teal + White）" — plain base kits whose COLOURWAY
    # happens to contain "&"/"+". A bundle must also name an actual extra kit.
    if (
        re.search(r"base|ベース", title, re.IGNORECASE)
        and re.search(r"[+&/]|\band\b|\bwith\b|\bplus\b", title, re.IGNORECASE)
        and _BUNDLE_EXTRA_RE.search(title)
    ):
        return "BUNDLE"
    if re.search(r"novelt|ノベルティ", title, re.IGNORECASE):
        return "NOVELTIES"
    if re.search(r"space\s*bar|スペースバー", title, re.IGNORECASE):
        return "SPACEBARS"
    if re.search(r"alpha|アルファ", title, re.IGNORECASE):
        return "ALPHA"
    if re.search(r"base|ベース", title, re.IGNORECASE):
        return "BASE"
    return "OTHERS"


def is_plausible_base_price(price: float, currency: str | None) -> bool:
    # Unknown currency → bound as USD (the fallback is always a western
    # vendor currency); currencies without bounds are not bounded.
    bounds = _KIT_BOUNDS.get(currency or "USD")
    if bounds is None:
        return price > 0
    # bounds[0] is 0 by design — see the _KIT_BOUNDS comment. A 0 or negative
    # price is a parse failure, not a cheap product, so it is still refused.
    return price > bounds[0] and price <= bounds[1]


def choose_kit_variant(
    variants: list[dict], allow_subkits: bool = False
) -> dict | None:
    """Pick the variant that is actually the BASE kit, NOT the cheapest one.

    `allow_subkits` is for a set that IS a subkit. dcs.wiki catalogs several as
    products in their own right — "DCS After School 1992 40s kit", "DCS 10U
    Spacebars", "DCS Bae Addon" — and on those listings the 40s/spacebar variant
    is the base kit, not something to exclude. Saber Keebs' After School page is
    the case that found this: its variants are "40s Monokit" $140, "BAE" $10 and
    "LAE" $10, and dropping the 40s variant left the $10 add-ons as the only
    candidates, so the set would have been priced at $10. Same reasoning as the
    product-level subkit guard in run_discovery, one level down.


    Preference: a variant classified BASE by title > the DEAREST remaining
    candidate. The base kit is the comprehensive, full-price kit; the other
    candidates on a GB listing are individual subkits (40s kit, accents, an
    ex-GST line…) that are cheaper. Reporters repeatedly confirmed this — the
    picker kept storing a cheap subkit because it took the first variant in
    display order, so we now take the most expensive candidate instead. A
    single-kit listing ('Default Title') has one candidate, so the max is it.

    Variants classified as a non-base STANDARD subkit (alphas, novelties,
    spacebars) are excluded outright — those are cheap add-on kits, never the
    base. When a listing carries ONLY subkits (no base kit on offer — e.g.
    Keygem listing a rainy-day GB with just novelties/spacebars), there is no
    base price to store, so return None and let the caller skip it rather than
    fall through to a misleading subkit price."""
    if not variants:
        return None
    non_addon = [v for v in variants if not _ADDON_VARIANT_RE.search(v["title"])]
    if not non_addon:
        # EVERY variant is an accessory (deskmats/artisans): the listing sells
        # no base kit at all. Falling back to the raw list — the old behavior —
        # stored a deskmat price as the base. Mirrors pickBaseVariant (TS).
        return None
    pool = non_addon
    # Drop labeled subkits so an absent base kit can't fall through to a cheap
    # alpha/novelty/spacebar variant; BASE and unlabeled OTHERS are retained.
    # An OTHERS variant that names a non-base subkit (e.g. a numpad) is dropped
    # too, so a numpad-only listing yields no base candidate and clears.
    base_pool = [
        v
        for v in pool
        if classify_variant(v["title"]) == "BASE"
        or (
            classify_variant(v["title"]) == "OTHERS"
            and (allow_subkits or not _NONBASE_SUBKIT_RE.search(v["title"]))
        )
    ]
    for v in base_pool:
        if classify_variant(v["title"]) == "BASE":
            return v
    # No plain base kit on offer: fall back to the CHEAPEST bundle instead of
    # storing nothing. A bundle costs more than the base alone, so it is used
    # only when there is no base to be had — that keeps a dearer bundle from
    # displacing a real base kit, and keeps the pick independent of the
    # vendor's variant order.
    if not base_pool:
        bundles = [v for v in pool if classify_variant(v["title"]) == "BUNDLE"]
        if not bundles:
            return None
        return min(bundles, key=lambda v: v["price"])
    # No variant is titled "base": the real base is the dearest candidate, not
    # whichever subkit happens to come first in display order (an out-of-range
    # bundle is rejected downstream by is_plausible_base_price).
    return max(base_pool, key=lambda v: v["price"])


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
    """Shopify product.json variants → [{id, title, price, compareAt}].

    compareAt is the store's pre-discount price. It is kept ONLY when strictly
    greater than price: Shopify leaves the field populated at the same value on
    plenty of listings, and treating that as a markdown would advertise a 0%
    discount on half the catalogue.
    """
    out: list[dict] = []
    for v in raw_variants:
        try:
            p = float(v.get("price"))
        except (TypeError, ValueError):
            continue
        if p <= 0:
            continue
        try:
            compare = float(v.get("compare_at_price"))
        except (TypeError, ValueError):
            compare = 0.0
        entry = {
            "id": str(v.get("id") or ""),
            "title": str(v.get("title") or ""),
            "price": p,
        }
        if compare > p:
            entry["compareAt"] = compare
        out.append(entry)
    return out


def _pick_variant(
    variants: list[dict], pinned_id: str | None, allow_subkits: bool = False
) -> dict | None:
    """Pinned ?variant=<id> beats any title heuristic (mirrors prices.ts)."""
    if pinned_id:
        for v in variants:
            if v["id"] == pinned_id:
                return v
    return choose_kit_variant(variants, allow_subkits=allow_subkits)


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


# ---- Generic (non-Shopify) storefronts ------------------------------------
# Latamkeys (/productos/) and STACKS (/store/) are WooCommerce, not Shopify, so
# shopify_price() bails on the missing /products/ path and the caller KEEPS the
# stale price — these listings never re-price and reporters keep flagging the
# wrong (subkit / pre-GST) number. Parsing the WooCommerce variation blob lets
# choose_kit_variant() pick the real base kit here too, exactly as on Shopify.

# WooCommerce variable products embed every variation as JSON in the add-to-cart
# form's data-product_variations attribute. The value is HTML-escaped.
_WOO_VARIATIONS_RE = re.compile(
    r"""data-product_variations\s*=\s*(["'])(.*?)\1""", re.DOTALL
)


def parse_woocommerce_variations(html: str) -> list[dict]:
    """WooCommerce variable product → [{id, title, price, available}].

    `display_price` is a plain number already in the store's base currency, so
    no symbol parsing is needed. The variation's attribute values become the
    title so classify_variant() can tell a base kit from a subkit. Returns []
    for simple products or non-WooCommerce pages (caller falls back)."""
    match = _WOO_VARIATIONS_RE.search(html)
    if not match:
        return []
    try:
        data = json.loads(html_unescape(match.group(2)))
    except (json.JSONDecodeError, TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for v in data:
        if not isinstance(v, dict):
            continue
        raw_price = v.get("display_price")
        if raw_price is None:
            raw_price = v.get("display_regular_price")
        try:
            price = float(raw_price)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        attrs = v.get("attributes")
        title = (
            " ".join(str(x) for x in attrs.values() if x)
            if isinstance(attrs, dict)
            else ""
        )
        out.append(
            {
                "id": str(v.get("variation_id") or v.get("id") or ""),
                "title": title,
                "price": price,
                "available": bool(v.get("is_in_stock", True)),
            }
        )
    return out


def parse_jsonld_offer(html: str):
    """Simple (non-variable) product price from JSON-LD Product/Offer.

    Name-aware, mirroring fetchJsonLdPrice (prices.ts): an offer whose name
    classifies BASE wins; multiple offers with no identifiable base is an
    ambiguous multi-kit aggregate (the dearest child could be a bundle, the
    cheapest a spacebars kit — either guess poisons the base price), and a
    single offer NAMED as a subkit/accessory is not the base either — both
    return NO_BASE_KIT so a stale wrong price heals instead of persisting.
    Unnamed single/simple offers return the dearest candidate as before.
    Returns {price, available}, NO_BASE_KIT, or None (nothing priced).
    Currency is taken from the vendor override, never the page, to match
    shopify_price()."""
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    found: list[dict] = []

    def walk(node) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        offers = node.get("offers")
        candidates = (
            offers if isinstance(offers, list)
            else [offers] if isinstance(offers, dict)
            else []
        )
        for offer in candidates:
            if not isinstance(offer, dict):
                continue
            raw = offer.get("price") or offer.get("lowPrice") or offer.get("highPrice")
            try:
                # INR/ARS use ',' as the thousands separator, '.' as decimal.
                price = float(str(raw).replace(",", ""))
            except (TypeError, ValueError):
                continue
            if price <= 0:
                continue
            availability = offer.get("availability")
            in_stock = not (
                isinstance(availability, str)
                and re.search(r"outofstock|soldout|discontinued", availability, re.IGNORECASE)
            )
            name = str(offer.get("name") or "")
            found.append({"price": price, "available": in_stock, "name": name})
        for child in node.values():
            walk(child)

    for block in blocks:
        try:
            walk(json.loads(html_unescape(block.strip())))
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    if not found:
        return None

    # An offer named as the base kit is authoritative (dearest of them, in
    # case regional base lines coexist).
    named_base = [o for o in found if classify_variant(o["name"]) == "BASE"]
    if named_base:
        return max(named_base, key=lambda o: o["price"])
    # No plain base offer: a bundle that includes the base ("Base + Novelties")
    # is the base-bearing option, so use the cheapest rather than refusing to
    # price the listing. A plain base, when present, always wins above.
    bundles = [o for o in found if classify_variant(o["name"]) == "BUNDLE"]
    if bundles:
        return min(bundles, key=lambda o: o["price"])
    if len(found) > 1:
        # Multi-kit aggregate with no identifiable base — do not guess.
        return NO_BASE_KIT
    only = found[0]
    name = only["name"]
    if name and (
        classify_variant(name) in ("NOVELTIES", "SPACEBARS", "ALPHA")
        or _NONBASE_SUBKIT_RE.search(name)
        or _TITLE_ACCESSORY_RE.search(name)
    ):
        # The single remaining offer IS a subkit/accessory — no base on offer.
        return NO_BASE_KIT
    return only


def shopify_price(
    page: Page,
    product_url: str,
    vendor_currency: str | None,
    scrapling: ScraplingClient | None = None,
    allow_subkits: bool = False,
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
    # HTTP status of the browser navigation to the product page, used to tell a
    # genuinely removed listing (404/410 → clear the stale price) apart from a
    # transient block (keep the last good price).
    nav_status: int | None = None
    # Where that navigation actually ENDED. A removed Shopify product is usually
    # answered with a redirect to the store's front door rather than a 404, and
    # the redirect is silent — without this the row reads as a transient block
    # for ever. See is_gone_redirect.
    nav_final_url: str | None = None

    def ensure_browser() -> None:
        nonlocal browser_loaded, clean, nav_status, nav_final_url
        if browser_loaded:
            return
        response = page.goto(
            product_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS
        )
        nav_status = response.status if response is not None else None
        nav_final_url = page.url
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
            # Dead-link audit: a removed product page returns 404/410. That's a
            # definitively gone listing, so CLEAR the stale price (DEAD_LINK)
            # instead of preserving it the way we do for a transient block.
            if nav_status in DEAD_LINK_STATUSES:
                log(f"  dead link ({nav_status}) — clearing price ({product_url})")
                return DEAD_LINK
            # …and the answer a removed product gives more often than a 404: the
            # store redirected us to its own front door. Just as definitive, and
            # it never produced a status we could read.
            if is_gone_redirect(product_url, nav_final_url):
                log(
                    f"  dead link (redirected to {nav_final_url}) — clearing "
                    f"price ({product_url})"
                )
                return DEAD_LINK
            return None

        origin = urllib.parse.urlsplit(clean)
        origin_url = f"{origin.scheme}://{origin.netloc}"

        # Reject pages where the PRODUCT itself is a subkit or accessory — the
        # kit identity of a single-variant product lives in the product title
        # (its lone variant is Shopify's literal "Default Title", which
        # classifies OTHERS and would be stored as the base). Vendors sell
        # novelties/spacebars/artisans as separate products ("GMK Foo
        # Novelties"; ilumkb's "Lavender x RAMA Artisan Keycap" at
        # /products/gmk-lavender). Clearing (NO_BASE_KIT) beats keeping: a
        # mislinked row's stale price must heal, not persist. A vendor-pinned
        # ?variant= link is ground truth and bypasses the guard.
        product_title = str(data["product"].get("title") or "")
        if not pinned_id and product_title:
            title_category = classify_variant(product_title)
            if (
                title_category in ("NOVELTIES", "SPACEBARS")
                or _NONBASE_SUBKIT_RE.search(product_title)
                # Product-title-safe accessory set: _ADDON_VARIANT_RE's
                # "extra"/"shipping" would wrongly clear real "GMK Foo
                # Extras" / "... Free Shipping" listings.
                or _TITLE_ACCESSORY_RE.search(product_title)
            ):
                log(f"  product is a subkit/accessory — clearing ({product_url})")
                return NO_BASE_KIT

        variants = _parse_shopify_variants(data["product"].get("variants") or [])
        chosen = _pick_variant(variants, pinned_id, allow_subkits)
        if chosen is None:
            # We read the product fine but it has no base candidate (only
            # subkits) and the vendor didn't pin a variant. Signal a CLEAR so a
            # previously-stored subkit price is removed, not preserved as stale.
            # An empty variant list is a parse miss (transient) → plain skip.
            return NO_BASE_KIT if variants else None

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
                    c2 = _pick_variant(v2, pinned_id, allow_subkits)
                    if c2 is not None:
                        variants, chosen = v2, c2
            except Exception:  # noqa: BLE001
                pass

        # Fall back to the vendor's own currency (e.g. DeskHero = CAD), never
        # a blind USD default that inflates CA$88 into US$88.
        currency = currency or vendor_currency

        # Refuse currencies the site can't convert — they render as garbage.
        # PRICE_REFUSED, never None: the page was read and understood, and
        # answering "couldn't reach it" files a live store as an unreachable
        # one for as long as the refusal stands.
        if currency and currency not in _SUPPORTED_CURRENCIES:
            log(f"  unsupported currency {currency} — refused ({product_url})")
            return PRICE_REFUSED

        if not is_plausible_base_price(chosen["price"], currency):
            log(f"  implausible kit price {chosen['price']} {currency} — refused ({product_url})")
            return PRICE_REFUSED

        in_stock = _base_variants_in_stock(
            variants, chosen, pinned_id, availability_by_id
        )
        # Stored variants carry title+price only (what the UI parses).
        # Persist per-variant availability when Shopify reported it, so the
        # set page's "Complete the set" section can show subkit stock the same
        # way the base table does. Unknown stock is omitted, not guessed.
        variants = [
            {
                "title": v["title"],
                "price": v["price"],
                **(
                    {"available": availability_by_id[v["id"]]}
                    if v["id"] in availability_by_id
                    else {}
                ),
            }
            for v in variants
        ]
        return {
            "price": chosen["price"],
            "currency": currency,
            "variants": variants,
            "inStock": in_stock,
            # Only the CHOSEN variant's markdown — a discount on some unrelated
            # subkit says nothing about the base kit's price.
            "compareAt": chosen.get("compareAt"),
        }
    except Exception as e:  # noqa: BLE001
        # A host that no longer resolves is the store saying "gone" with no HTTP
        # answer at all. This half has no generic fallback to defer to — the
        # caller picks ONE path per URL — so it reads the verdict off the
        # navigation it just attempted, which is the human product page.
        if is_gone_host_error(e):
            log(f"  dead link (host does not resolve) — clearing price ({product_url})")
            return DEAD_LINK
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

# Minimum gap between requests to the SAME host, with a little jitter.
#
# Stores rate-limit per IP, and HTTP 429 is one of the statuses the block
# detector counts as "blocked". The 2026-08-01 run fired 500 price fetches
# back-to-back and came back with blocked=424; the week before, 39 fetches
# produced 5. The endpoints were never walled off — they answer 200 fine — we
# were simply asking too fast. Every other pass that hammers one host (Geekhack)
# already sleeps between requests; the price and discovery passes did not.
#
# Requests to DIFFERENT hosts never wait on each other, so a queue spread over
# many stores costs almost nothing. Both passes check the deadline each
# iteration, so if throttling means fewer rows this run, the oldest-first
# rotation just picks the rest up next run.
HOST_MIN_INTERVAL_S = 1.5
HOST_JITTER_S = 0.5


class HostThrottle:
    """Space out requests per host so a big queue doesn't trip rate limits."""

    def __init__(self, interval: float = HOST_MIN_INTERVAL_S,
                 jitter: float = HOST_JITTER_S) -> None:
        self._interval = interval
        self._jitter = jitter
        self._last: dict[str, float] = {}

    @staticmethod
    def interleave(rows: list[dict], key: str = "productUrl") -> list[dict]:
        """Round-robin rows across hosts so the throttle rarely has to sleep.

        fetch_price_candidates orders oldest-first, which CLUSTERS by host —
        listings discovered in the same run share a timestamp. Walking a cluster
        back to back is the one case the per-host throttle has to slow down, so
        spread the hosts out instead: the same rows, in an order that costs far
        less wall clock. Relative order within a host is preserved, so the
        oldest listing for each store is still checked first.
        """
        buckets: dict[str, list[dict]] = {}
        for row in rows:
            host = urllib.parse.urlsplit(row.get(key) or "").netloc.lower()
            buckets.setdefault(host, []).append(row)
        spread: list[dict] = []
        while buckets:
            for host in list(buckets):
                spread.append(buckets[host].pop(0))
                if not buckets[host]:
                    del buckets[host]
        return spread

    def wait(self, url: str) -> float:
        """Sleep until this host may be hit again. Returns seconds slept."""
        host = urllib.parse.urlsplit(url or "").netloc.lower()
        if not host:
            return 0.0
        previous = self._last.get(host)
        slept = 0.0
        if previous is not None:
            gap = self._interval + (
                random.uniform(0, self._jitter) if self._jitter else 0.0
            )
            remaining = (previous + gap) - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
                slept = remaining
        self._last[host] = time.monotonic()
        return slept

# Once a set reaches one of these statuses its gmk.net catalog page is frozen —
# the name, designer, description, and gallery never change again. The catalog
# and image passes skip these sets entirely; only prices keep rotating.
# IN_STOCK and SHIPPING are NOT terminal: extras sell out and shipments arrive,
# so those still get rechecked for the status transition.
TERMINAL_STATUSES = ("DELIVERED", "CANCELLED")

# Vendors that are MANUFACTURER/catalog markers, not stores. Their VendorKit
# rows exist only to carry a catalog URL (gmk.net, dcs.wiki) for the catalog and
# image passes, so they must never be priced or crawled for listings.
#
# This used to be a bare `slug <> 'gmk'` in two places. When dcs.wiki was added
# it inherited none of that, so all 135 wiki rows landed in the price queue —
# and because they had never been priced they sorted FIRST under
# `priceUpdatedAt ASC NULLS FIRST`, pushing real vendor listings past the 500
# row cap. Keep new manufacturer sources in this list.
MANUFACTURER_VENDOR_SLUGS = ("gmk", "dcs-wiki")
MANUFACTURER_URL_PATTERNS = ("%gmk.net%", "%dcs.wiki%")


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
                  JOIN "Vendor" v ON v.id = vk."vendorId"
                 WHERE k."groupBuyId" = gb.id
                   AND v.slug = 'gmk'
                   AND vk."productUrl" ILIKE '%%gmk.net%%'
                   AND vk."productUrl" NOT ILIKE '%%warehouse-finds%%')
    """
    with conn.cursor() as cur:
        cur.execute(sql, (list(TERMINAL_STATUSES),))
        return {row[0] for row in cur.fetchall()}


def fetch_image_candidates(conn, limit: int = 200) -> list[dict]:
    sql = """
        SELECT gb.id, gb.slug, gb."imageUrl", gb.images,
               -- Manufacturer link ONLY (vendor slug 'gmk'): the gmk-direct
               -- Warehouse Finds URL is a shared multi-set sale page — scraping
               -- it filled galleries with OTHER sets' photos (gmk-lazurite).
               (SELECT vk."productUrl"
                  FROM "VendorKit" vk
                  JOIN "Kit" k ON k.id = vk."kitId"
                  JOIN "Vendor" v ON v.id = vk."vendorId"
                 WHERE k."groupBuyId" = gb.id
                   AND v.slug = 'gmk'
                   AND vk."productUrl" ILIKE '%%gmk.net%%'
                   AND vk."productUrl" NOT ILIKE '%%warehouse-finds%%'
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
                  JOIN "Vendor" v ON v.id = vk."vendorId"
                 WHERE k."groupBuyId" = gb.id
                   AND v.slug = 'gmk'
                   AND vk."productUrl" ILIKE '%%gmk.net%%'
                   AND vk."productUrl" NOT ILIKE '%%warehouse-finds%%')
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
    # Manufacturer/catalog rows (GMK -> gmk.net, DCS -> dcs.wiki) only carry a
    # catalog URL for the catalog/image passes and must never be priced.
    # Two cadences, not one. A row whose page the store says is GONE
    # (deadSince), or that has been unreadable DEAD_LINK_FAILURE_THRESHOLD runs
    # in a row, waits DEAD_LINK_RECHECK_HOURS instead of PRICE_MAX_AGE_HOURS. It
    # cannot be priced, and this pass is time-boxed, so re-fetching it every six
    # hours costs live listings their turn — and an unpriced live listing is
    # hidden outright on a RELEASED set, which is where most listings are. Left
    # on the fast cadence, several hundred permanently-dead rows were crowding
    # out the stores that can still sell something.
    #
    # A back-off, never a retirement: the row keeps its place in the queue, and
    # next_link_health resets both columns on the first read that gets through,
    # so a store that comes back needs no intervention. Mirror of the same split
    # in refreshPrices (prices.ts).
    sql = """
        SELECT vk.id, vk."productUrl", vk."linkFailures", vk."deadSince",
               v.currency AS vendor_currency, gb.name AS set_name
          FROM "VendorKit" vk
          JOIN "Kit" k ON k.id = vk."kitId"
          JOIN "GroupBuy" gb ON gb.id = k."groupBuyId"
          JOIN "Vendor" v ON v.id = vk."vendorId"
         WHERE vk."productUrl" IS NOT NULL
           AND btrim(vk."productUrl") <> ''
           AND k.type = 'BASE'
           AND NOT (v.slug = ANY(%s))
           AND NOT (vk."productUrl" ILIKE ANY(%s))
           AND (vk."priceSource" IS NULL OR vk."priceSource" <> 'MANUAL')
           AND (vk."priceUpdatedAt" IS NULL
                OR vk."priceUpdatedAt" < now() - make_interval(hours =>
                     CASE WHEN vk."deadSince" IS NOT NULL
                                OR coalesce(vk."linkFailures", 0) >= %s
                          THEN %s ELSE %s END))
         ORDER BY vk."priceUpdatedAt" ASC NULLS FIRST
         LIMIT %s
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (
            list(MANUFACTURER_VENDOR_SLUGS),
            list(MANUFACTURER_URL_PATTERNS),
            DEAD_LINK_FAILURE_THRESHOLD,
            DEAD_LINK_RECHECK_HOURS,
            PRICE_MAX_AGE_HOURS,
            limit,
        ))
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


def gmk_breadcrumb_text(content: str) -> str:
    """Return the product page's breadcrumb text (e.g. 'Home Group Buys'), or ''.

    Matches ONLY a real breadcrumb element (its class contains 'breadcrumb') and
    closes the same tag via a backreference. The previous loose regex matched the
    word 'navigation' inside a <script> config and captured a huge JS blob that
    happened to contain 'shipping' — so every gmk.net product mis-inferred
    SHIPPING even when its breadcrumb actually read 'Group Buys'."""
    match = re.search(
        r"<(nav|ol|ul)[^>]*\bbreadcrumb[^>]*>(.*?)</\1>",
        content,
        re.DOTALL | re.IGNORECASE,
    )
    if not match:
        return ""
    text = re.sub(r"<[^>]+>", " ", match.group(2))
    text = re.sub(r"\s+", " ", text).strip()
    # A real breadcrumb is short ("Home Group Buys"); anything long is a bad
    # match (nested markup) and would just reintroduce false keyword hits.
    return text if len(text) <= 300 else ""


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

        # Breadcrumb / category text for status inference (gmk.net files a set
        # under Group Buys / In Production / … — that category drives the status).
        breadcrumb = gmk_breadcrumb_text(content)
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
            # The row already exists in every live DB, so the INSERT below never
            # runs there. Repoint it here or the 404 crawl persists forever.
            cur.execute(
                'UPDATE "Vendor" SET "websiteUrl" = %s, country = %s '
                'WHERE id = %s AND ("websiteUrl" IS DISTINCT FROM %s OR country IS DISTINCT FROM %s)',
                (ZFRONTIER_STORE_ORIGIN, "HK", vendor_id, ZFRONTIER_STORE_ORIGIN, "HK"),
            )
        else:
            cur.execute("""
                INSERT INTO "Vendor"
                    (id, slug, name, region, country, currency, "websiteUrl", "logoUrl")
                VALUES
                    (gen_random_uuid()::text, %s, 'GMK', 'EU', 'DE', 'EUR', %s, NULL)
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


def build_keycap_norm_index(conn) -> dict:
    """Existing keycap sets indexed by normalized name, for divergent-slug reuse.

    The slug a source chooses is its own: gmk.net files "GMK CYL Mizu R2
    Keycaps" under gmk-cyl-mizu-r2-keycaps while KeycapLendar files the same
    product under gmk-mizu-r2. An upsert that only looks up the slug therefore
    writes a SECOND row for one set — the "orphan duplicate" _build_set_index
    routes listings around. normalize_set_name already drops "CYL" and
    "Keycaps", so it recognises the pair; this makes the upserts use it.
    """
    index: dict[str, list[dict]] = {}
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""SELECT id, name, status::text AS status FROM "GroupBuy"
                        WHERE "productType" = 'KEYCAPS' AND slug NOT LIKE 'custom-%'""")
        for row in cur.fetchall():
            key = normalize_set_name(row.get("name") or "")
            if key:
                index.setdefault(key, []).append({"id": row["id"], "status": row["status"]})
    return index


def _existing_set_by_name(norm_index: dict | None, name: str) -> dict | None:
    """The one existing row this name belongs to, or None.

    Ambiguity is never resolved by guessing: two rows sharing a normalized name
    are themselves a duplicate the db-setup merge has to settle, and picking one
    here would attach the source's URL to whichever happened to be listed first.
    """
    if not norm_index:
        return None
    key = normalize_set_name(name or "")
    if not key:
        return None
    candidates = norm_index.get(key) or []
    return candidates[0] if len(candidates) == 1 else None


def upsert_gmk_set(conn, data: dict, vendor_id: str, *,
                   vk_currency: str = "EUR",
                   protect_terminal: bool = False,
                   norm_index: dict | None = None) -> tuple:
    """Upsert a GroupBuy + BASE Kit + vendor link. Returns (gb_id, created).

    protect_terminal: don't overwrite a DELIVERED/CANCELLED status — used by
    sources (zFrontier regional GBs) that may still list a set as active
    after the worldwide run has shipped.

    norm_index: when the slug is unknown, fall back to an unambiguous
    normalized-name match so a divergently-slugged source updates the existing
    row instead of creating a duplicate of it (see build_keycap_norm_index).
    """
    slug = data["slug"]

    # Cancelled sets never went to production — the site removes them entirely
    # (db-setup purges them on deploy), so don't (re)create them here either.
    if re.search(r"\bcancell?ed\b", data.get("name") or "", re.IGNORECASE) or "cancel" in slug:
        return None, False

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
        existing = cur.fetchone()

    if not existing:
        existing = _existing_set_by_name(norm_index, data.get("name") or "")

    if existing:
        gb_id = existing["id"]
        if protect_terminal:
            status_sql = ('CASE WHEN status::text = ANY(%s) THEN status '
                          'ELSE %s::"GBStatus" END')
            status_params = (list(TERMINAL_STATUSES), data["status"])
        else:
            # Date-derived status wins for a set whose GB window is currently
            # OPEN. gmk.net's breadcrumb frequently reads "in production /
            # shipping" for a set whose community group buy is still live, which
            # would otherwise downgrade a KeycapLendar-dated ACTIVE_GB row on
            # every nightly catalog run. Mirror of the daily status sweep in
            # db-setup.mjs / cron refresh (SHIPPING + in-window -> ACTIVE_GB).
            status_sql = (
                'CASE WHEN "gbStart" IS NOT NULL AND "gbStart" <= now() '
                'AND "gbEnd" IS NOT NULL AND "gbEnd" >= now() '
                'AND status::text NOT IN (\'DELIVERED\', \'CANCELLED\') '
                'THEN \'ACTIVE_GB\'::"GBStatus" ELSE %s::"GBStatus" END'
            )
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
                WHERE id = %s
            """, (*status_params, data["name"], data.get("designer") or "",
                  data.get("description") or "", gb_id))
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
        # Register the new row so a second URL for the same set later in this
        # run reuses it rather than adding another spelling of it.
        if norm_index is not None:
            key = normalize_set_name(data["name"])
            if key:
                norm_index.setdefault(key, []).append(
                    {"id": gb_id, "status": data["status"]}
                )

    # Store the gmk.net product page on a GMK VendorKit row. GMK is the
    # MANUFACTURER, not a vendor — this row is never priced or displayed; it
    # exists solely to carry the gmk.net URL for the image/catalog passes.
    #
    # An EXISTING row is not guaranteed to have a BASE kit — a Geekhack-sourced
    # one never did — and the name fallback above now sends this pass down that
    # branch far more often. Without a kit there is nowhere to hang the URL, so
    # the catalog and image passes would never see the set.
    ensure_base_kit(conn, gb_id)
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
    # gmk.net's own slugs ("gmk-cyl-mizu-r2-keycaps") diverge from the ones the
    # rest of the catalog uses ("gmk-mizu-r2"), so a slug-only upsert wrote this
    # pass's own duplicate of every set it already had.
    norm_index = build_keycap_norm_index(conn)
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
            _, created = upsert_gmk_set(
                conn, metadata, gmk_vendor_id, norm_index=norm_index
            )
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
# dcs.wiki catalog — the DCS profile's canonical source
# GMK sets get their identity from gmk.net (run_catalog above). DCS sets had no
# equivalent: their only source was Geekhack, so rows carried thread titles
# ("[GB] DCS Mermaid | Running Oct 17 - Nov 14") and gh-<topic> slugs.
# https://dcs.wiki is the DCS archive and fills exactly the gmk.net role:
#   /keycaps     — 135-set archive; each card carries the set name in an
#                  aria-label and links to /keycaps/<slug>
#   /keycaps/... — designer, release date, GB type, colors, price, GB location,
#                  and a "Group Buy Page" link to the vendor actually running it
#   /group-buys  — live status in two <h1> sections: Active Group Buys (cards
#                  link to /keycaps/<slug>) and Active Interest Checks (cards
#                  link straight out to Geekhack)
# The pages are server-rendered, so a plain fetch sees the full markup.
#
# The "Group Buy Page" link is the valuable part: it often points at a store we
# already track (DCS Soju -> unikeyboards.com, an existing UniKeys vendor), so
# the catalog can hand run_prices a scrapeable URL instead of waiting for
# run_discovery to rediscover the listing.
# ----------------------------------------------------------------------------

DCS_WIKI_ORIGIN = "https://dcs.wiki"
DCS_WIKI_ARCHIVE_URL = f"{DCS_WIKI_ORIGIN}/keycaps"
DCS_WIKI_GROUP_BUYS_URL = f"{DCS_WIKI_ORIGIN}/group-buys"
DCS_VENDOR_SLUG = "dcs-wiki"

_DCS_SCRIPT_RE = re.compile(r"<script.*?</script>", re.S | re.I)
_DCS_TAG_RE = re.compile(r"<[^>]+>")
# Both the archive index and the Active Group Buys cards use this same anchor
# shape, so one pattern reads names + slugs off either page.
_DCS_CARD_RE = re.compile(
    r'aria-label="Open\s+(?P<name>[^"]+?)\s+details"\s+href="/keycaps/(?P<slug>[a-z0-9-]+)"',
    re.I,
)
_DCS_EMPTY_FIELD_VALUES = {"", "—", "–", "-", "n/a", "na", "tbd", "unknown"}


def _dcs_text(fragment: str) -> str:
    """Strip tags/entities out of an HTML fragment and collapse whitespace."""
    return re.sub(r"\s+", " ", html_unescape(_DCS_TAG_RE.sub(" ", fragment or ""))).strip()


def _dcs_field(body: str, label: str) -> str | None:
    """Read one <p>LABEL</p><p>VALUE</p> detail pair; None when blank or a dash.

    Every field on a set page is optional (a running GB has no price yet, an old
    set has no designer credited), so a missing or em-dash value must come back
    as None rather than being written over good data as an empty string.
    """
    match = re.search(
        r">\s*" + re.escape(label) + r"\s*</p>\s*<p[^>]*>(.*?)</p>",
        body,
        re.S | re.I,
    )
    if not match:
        return None
    value = _dcs_text(match.group(1))
    return None if value.lower() in _DCS_EMPTY_FIELD_VALUES else value


def parse_dcs_archive_index(html: str) -> list[dict]:
    """Every set in the /keycaps archive as {slug, name}, in page order."""
    body = _DCS_SCRIPT_RE.sub("", html or "")
    sets: list[dict] = []
    seen: set[str] = set()
    for match in _DCS_CARD_RE.finditer(body):
        slug = match.group("slug").lower()
        if slug in seen:
            continue
        seen.add(slug)
        sets.append({"slug": slug, "name": _dcs_text(match.group("name"))})
    return sets


def parse_dcs_group_buys(html: str) -> dict:
    """Split /group-buys into live GB slugs and interest checks.

    Active Group Buys are matched by SLUG (their cards link to /keycaps/<slug>),
    which avoids any name-matching guesswork. Interest checks have no wiki page
    at all — their cards link straight to Geekhack — so they are returned with
    the topic id instead, letting the caller update the gh-<topic> row that the
    Geekhack pass already created.
    """
    body = _DCS_SCRIPT_RE.sub("", html or "")
    split = re.search(r"<h1[^>]*>\s*Active Interest Checks\s*</h1>", body, re.I)
    gb_part = body[: split.start()] if split else body
    ic_part = body[split.end():] if split else ""

    active_slugs: list[str] = []
    for match in re.finditer(r'href="/keycaps/([a-z0-9-]+)"', gb_part, re.I):
        slug = match.group(1).lower()
        if slug not in active_slugs:
            active_slugs.append(slug)

    interest_checks: list[dict] = []
    for match in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', ic_part, re.S | re.I):
        name_match = re.search(r"<p[^>]*>(.*?)</p>", match.group(2), re.S)
        name = _dcs_text(name_match.group(1)) if name_match else ""
        # Cards lead with the set name; the trailing nav/footer links don't.
        if not re.match(r"^dcs\b", name, re.I):
            continue
        url = match.group(1)
        topic = re.search(r"geekhack\.org/index\.php\?topic=(\d+)", url, re.I)
        interest_checks.append({
            "name": name,
            "url": url,
            "topic_id": topic.group(1) if topic else None,
        })

    return {"active_slugs": active_slugs, "interest_checks": interest_checks}


def parse_dcs_release_date(text: str | None) -> datetime | None:
    """Parse a wiki release date; None when it can't be read unambiguously.

    The field is hand-written, so it appears as '7/1/2026', 'January 2023',
    'July 2026' or a bare '2021'. Month-only values are pinned to the 1st.
    Anything else returns None rather than inventing a date.
    """
    value = (text or "").strip()
    if not value:
        return None
    match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", value)
    if match:
        month, day, year = (int(g) for g in match.groups())
        try:
            return datetime(year, month, day)
        except ValueError:
            return None
    for fmt in ("%B %Y", "%b %Y", "%B %d, %Y", "%b %d, %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    if re.match(r"^\d{4}$", value):
        return datetime(int(value), 1, 1)
    return None


def parse_dcs_set_page(html: str, url: str) -> dict | None:
    """Turn a /keycaps/<slug> page into upsert data, or None if unreadable.

    Returning None on a missing name matters: a failed/partial fetch must skip
    the set entirely rather than blank out a good row on the next run.
    """
    if not html:
        return None
    body = _DCS_SCRIPT_RE.sub("", html)

    name_match = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S | re.I)
    name = _dcs_text(name_match.group(1)) if name_match else ""
    if not name:
        return None

    slug_match = re.search(r"/keycaps/([a-z0-9-]+)", url, re.I)
    if not slug_match:
        return None
    slug = slug_match.group(1).lower()

    # The prose blurb is only reliably available as the page's meta description
    # (the visible copy is split across styled spans). Read it from the raw
    # HTML — <meta> lives in <head>, which the script strip above leaves intact.
    desc_match = re.search(
        r'<meta\s+name="description"\s+content="([^"]*)"', html, re.I
    )
    description = html_unescape(desc_match.group(1)).strip() if desc_match else ""

    images: list[str] = []
    for pattern in (
        r'<link[^>]+as="image"[^>]+href="(/images/[^"]+)"',
        r'<img[^>]+src="(/images/[^"]+)"',
    ):
        for match in re.finditer(pattern, html, re.I):
            absolute = DCS_WIKI_ORIGIN + match.group(1)
            if absolute not in images:
                images.append(absolute)

    # The GB link is an <a> that follows the "Group Buy Page" label rather than
    # a <p> value, so it needs its own lookup.
    gb_match = re.search(
        r">\s*Group Buy Page\s*</p>\s*<a[^>]+href="
        r'"(https?://[^"]+)"',
        body,
        re.S | re.I,
    )

    colors = _dcs_field(body, "Colors")
    return {
        "slug": slug,
        "name": name,
        "colorway": re.sub(r"^dcs\s+", "", name, flags=re.I).strip(),
        "designer": _dcs_field(body, "Designer"),
        "release_date": parse_dcs_release_date(_dcs_field(body, "Release Date")),
        "gb_type": _dcs_field(body, "GB Type"),
        # Signature Plastics colour codes (e.g. "BHG, BE, WGE") — a plastics
        # reference, NOT a kit list, so they never reach the kit classifier.
        "colors": colors,
        "price": _dcs_field(body, "Price"),
        "gb_location": _dcs_field(body, "Group Buy Location"),
        "gb_page_url": gb_match.group(1) if gb_match else None,
        "description": description,
        "imageUrl": images[0] if images else None,
        "images": images,
        "wiki_url": f"{DCS_WIKI_ARCHIVE_URL}/{slug}",
    }


def ensure_dcs_vendor(conn) -> str:
    """Return the dcs.wiki vendor id, creating it if needed.

    Like the 'gmk' row this is a MANUFACTURER/catalog marker, never priced or
    displayed — it exists to carry the wiki URL so the catalog pass can tell
    which sets it has already visited.

    NOTE: "Vendor" has no createdAt/updatedAt columns; naming them here is what
    broke a nightly run once before.
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "Vendor" WHERE slug = %s', (DCS_VENDOR_SLUG,))
        row = cur.fetchone()
        if row:
            return row["id"]
        cur.execute("""
            INSERT INTO "Vendor"
                (id, slug, name, region, country, currency, "websiteUrl", "logoUrl")
            VALUES
                (gen_random_uuid()::text, %s, 'DCS Wiki', 'US', 'US', 'USD', %s, NULL)
            ON CONFLICT (slug) DO UPDATE SET "websiteUrl" = EXCLUDED."websiteUrl"
            RETURNING id
        """, (DCS_VENDOR_SLUG, DCS_WIKI_ORIGIN))
        return cur.fetchone()["id"]


def fetch_frozen_dcs_slugs(conn) -> set[str]:
    """Slugs the DCS catalog pass can skip: terminal status + wiki link present.

    Mirrors fetch_frozen_catalog_slugs — the second condition matters because
    upsert_dcs_set is also what attaches the wiki link, so a delivered set that
    has never been visited still needs one pass.
    """
    sql = """
        SELECT gb.slug
          FROM "GroupBuy" gb
         WHERE gb.status::text = ANY(%s)
           AND EXISTS (
                SELECT 1 FROM "VendorKit" vk
                  JOIN "Kit" k ON k.id = vk."kitId"
                  JOIN "Vendor" v ON v.id = vk."vendorId"
                 WHERE k."groupBuyId" = gb.id
                   AND v.slug = %s)
    """
    with conn.cursor() as cur:
        cur.execute(sql, (list(TERMINAL_STATUSES), DCS_VENDOR_SLUG))
        return {row[0] for row in cur.fetchall()}


def _dcs_host(url: str | None) -> str:
    return urllib.parse.urlsplit(url or "").netloc.lower().removeprefix("www.")


def find_vendor_for_url(conn, url: str) -> str | None:
    """The tracked vendor whose site hosts this URL, or None if untracked.

    Matched on the registered websiteUrl host so a wiki "Group Buy Page" that
    points at a store we already scrape (UniKeys, Oblotzky, …) becomes a real
    priced listing; geekhack.org and one-off vendor sites simply return None
    and are left to run_discovery.
    """
    host = _dcs_host(url)
    if not host:
        return None
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            'SELECT id, "websiteUrl" FROM "Vendor" '
            'WHERE "websiteUrl" IS NOT NULL AND slug <> %s',
            (DCS_VENDOR_SLUG,),
        )
        for row in cur.fetchall():
            if _dcs_host(row["websiteUrl"]) == host:
                return row["id"]
    return None


def _attach_dcs_vendor_kit(conn, gb_id: str, vendor_id: str, url: str) -> None:
    """Point a vendor's BASE VendorKit row at `url` (price left to run_prices)."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            'SELECT id FROM "Kit" WHERE "groupBuyId" = %s AND type = \'BASE\' LIMIT 1',
            (gb_id,),
        )
        kit = cur.fetchone()
    if not kit:
        return
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO "VendorKit"
                (id, "kitId", "vendorId", "productUrl", "gbUrl", "inStock", currency, "updatedAt")
            VALUES
                (gen_random_uuid()::text, %s, %s, %s, %s, true, 'USD', now())
            ON CONFLICT ("kitId", "vendorId") DO UPDATE SET
                "productUrl" = EXCLUDED."productUrl",
                "gbUrl" = EXCLUDED."gbUrl",
                "updatedAt" = now()
        """, (kit["id"], vendor_id, url, url))


def upsert_dcs_set(conn, data: dict, vendor_id: str, status: str,
                   norm_index: dict | None = None) -> tuple:
    """Upsert a DCS GroupBuy + BASE Kit + wiki link. Returns (gb_id, created).

    Modelled on upsert_gmk_set: a terminal (DELIVERED/CANCELLED) row is never
    reopened, existing name/designer/description are supplemented rather than
    clobbered so manual edits survive, and an unknown slug falls back to an
    unambiguous normalized-name match so dcs.wiki's spelling of a set ("DCS
    After School 1992 40s kit") updates the row the rest of the catalog already
    has rather than duplicating it.
    """
    slug = data["slug"]

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
        existing = cur.fetchone()

    if not existing:
        existing = _existing_set_by_name(norm_index, data.get("name") or "")

    if existing:
        gb_id = existing["id"]
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE "GroupBuy" SET
                    status = CASE WHEN status::text = ANY(%s) THEN status
                                  ELSE %s::"GBStatus" END,
                    name = CASE WHEN (name IS NULL OR name = '') THEN %s ELSE name END,
                    designer = CASE WHEN (designer IS NULL OR designer = '') THEN %s ELSE designer END,
                    description = CASE WHEN (description IS NULL OR description = '') THEN %s ELSE description END,
                    "imageUrl" = COALESCE(NULLIF("imageUrl", ''), %s),
                    "gbStart" = COALESCE("gbStart", %s),
                    "updatedAt" = now()
                WHERE id = %s
            """, (
                list(TERMINAL_STATUSES), status, data["name"],
                data.get("designer") or "", data.get("description") or "",
                data.get("imageUrl"), data.get("release_date"), gb_id,
            ))
        created = False
    else:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO "GroupBuy"
                    (id, slug, name, colorway, designer, status, "productType",
                     "imageUrl", images, description, "gbStart", featured,
                     "createdAt", "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, %s, %s, %s, %s, 'KEYCAPS',
                     %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (slug) DO NOTHING
                RETURNING id
            """, (
                slug, data["name"], data.get("colorway") or "",
                data.get("designer") or "", status,
                data.get("imageUrl"), data.get("images") or [],
                data.get("description") or "", data.get("release_date"),
                status == "ACTIVE_GB",
            ))
            row = cur.fetchone()
            if not row:
                cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
                row = cur.fetchone()
            gb_id = row["id"]
        created = True
        if norm_index is not None:
            key = normalize_set_name(data["name"])
            if key:
                norm_index.setdefault(key, []).append({"id": gb_id, "status": status})

    # Vendor linking is only possible through a BASE kit (_build_set_index
    # INNER JOINs on it), so guarantee one before attaching anything.
    ensure_base_kit(conn, gb_id)
    _attach_dcs_vendor_kit(conn, gb_id, vendor_id, data["wiki_url"])

    # A GB page hosted by a store we already scrape becomes a real listing;
    # anything else (Geekhack, one-off sites) is left for run_discovery.
    gb_page = data.get("gb_page_url")
    if gb_page:
        store_vendor_id = find_vendor_for_url(conn, gb_page)
        if store_vendor_id:
            _attach_dcs_vendor_kit(conn, gb_id, store_vendor_id, gb_page)

    return gb_id, created


def apply_dcs_interest_checks(conn, interest_checks: list[dict]) -> int:
    """Mark Geekhack-sourced rows for wiki-listed ICs as INTEREST_CHECK.

    Interest checks have no /keycaps page, but their cards link to the Geekhack
    topic the Geekhack pass already imported, so the topic id maps straight onto
    the gh-<topic> slug — no fuzzy name matching. Terminal rows are left alone.
    """
    updated = 0
    for ic in interest_checks:
        if not ic.get("topic_id"):
            continue
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE "GroupBuy"
                   SET status = 'INTEREST_CHECK'::"GBStatus", "updatedAt" = now()
                 WHERE slug = %s
                   AND status::text <> ALL(%s)
                   AND status::text <> 'INTEREST_CHECK'
            """, (f"gh-{ic['topic_id']}", list(TERMINAL_STATUSES)))
            updated += cur.rowcount
    return updated


def run_dcs_catalog(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    """Discover every DCS set from dcs.wiki and upsert it.

    Runs alongside run_catalog (before the image/discovery/price passes) so DCS
    sets reach them with a real name, designer, image and vendor link.
    """
    stats = {"urls_found": 0, "sets_scraped": 0, "created": 0, "updated": 0,
             "skipped": 0, "failed": 0, "interest_checks": 0}
    log("DCS catalog pass: discovering DCS sets from dcs.wiki ...")

    vendor_id = ensure_dcs_vendor(conn)
    frozen_slugs = fetch_frozen_dcs_slugs(conn)
    norm_index = build_keycap_norm_index(conn)
    log(f"  {len(frozen_slugs)} released DCS set(s) already final — detail pages skipped.")

    page = context.new_page()
    try:
        gb_html = fetch_page_html(page, DCS_WIKI_GROUP_BUYS_URL, scrapling=scrapling)
        live = parse_dcs_group_buys(gb_html or "")
        active_slugs = set(live["active_slugs"])
        log(f"  {len(active_slugs)} active group buy(s), "
            f"{len(live['interest_checks'])} interest check(s).")
        stats["interest_checks"] = apply_dcs_interest_checks(conn, live["interest_checks"])

        index_html = fetch_page_html(page, DCS_WIKI_ARCHIVE_URL, scrapling=scrapling)
        entries = parse_dcs_archive_index(index_html or "")
        stats["urls_found"] = len(entries)
        log(f"  Found {len(entries)} set(s) in the archive.")

        for entry in entries:
            if now_ms() > deadline:
                log("DCS catalog pass: deadline reached during set scraping.")
                break
            slug = entry["slug"]
            # An active GB is never frozen — its status and price still move.
            if slug in frozen_slugs and slug not in active_slugs:
                stats["skipped"] += 1
                continue

            url = f"{DCS_WIKI_ARCHIVE_URL}/{slug}"
            detail = parse_dcs_set_page(
                fetch_page_html(page, url, scrapling=scrapling) or "", url
            )
            if not detail:
                stats["failed"] += 1
                continue

            # The archive lists only sets that exist; anything not currently
            # running has shipped. Interest checks never appear here.
            status = "ACTIVE_GB" if slug in active_slugs else "DELIVERED"
            stats["sets_scraped"] += 1
            _, created = upsert_dcs_set(
                conn, detail, vendor_id, status, norm_index=norm_index
            )
            if created:
                stats["created"] += 1
                log(f"  + {detail['name']} ({status})")
            else:
                stats["updated"] += 1
    finally:
        page.close()

    log(
        f"DCS catalog pass: sets={stats['urls_found']} scraped={stats['sets_scraped']} "
        f"created={stats['created']} updated={stats['updated']} "
        f"skipped={stats['skipped']} failed={stats['failed']} "
        f"ics={stats['interest_checks']}"
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

# zFrontier runs TWO sites. www.zfrontier.com is the CN app whose collection
# pages the GB-card pass above reads; en.zfrontier.com is a separate, ordinary
# Shopify storefront (359 products, 107 of them GMK/DCS, USD, HK).
#
# The vendor row pointed at the app, so discovery built
# www.zfrontier.com/products.json — a 404 — and had been crawling zFrontier for
# nothing. The vendor's websiteUrl is the STOREFRONT, so discovery reaches the
# catalogue and the price pass can price it; the GB-card pass keeps using
# ZFRONTIER_ORIGIN, which is a different job on a different host.
ZFRONTIER_STORE_ORIGIN = "https://en.zfrontier.com"

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
            # The row already exists in every live database, so the INSERT below
            # never runs there. Repoint it here, or the 404 crawl persists.
            cur.execute(
                'UPDATE "Vendor" SET "websiteUrl" = %s, country = %s WHERE id = %s',
                (ZFRONTIER_STORE_ORIGIN, "HK", vendor_id),
            )
        else:
            # Country/currency per the storefront's own meta.json (HK / USD);
            # region stays ASIA, which is what shipping estimates key off.
            cur.execute("""
                INSERT INTO "Vendor"
                    (id, slug, name, region, country, currency, "websiteUrl", "logoUrl")
                VALUES
                    (gen_random_uuid()::text, %s, 'zFrontier', 'ASIA', 'HK', 'USD', %s, NULL)
                ON CONFLICT (slug) DO UPDATE SET
                    "websiteUrl" = EXCLUDED."websiteUrl",
                    country = EXCLUDED.country
                RETURNING id
            """, (ZFRONTIER_VENDOR_SLUG, ZFRONTIER_STORE_ORIGIN))
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
    norm_index = build_keycap_norm_index(conn)
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
                    norm_index=norm_index,
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
# KBDfans group-buy collection — GMK keycap interest checks & live group buys
# ----------------------------------------------------------------------------
# KBDfans lists every GMK keycap group buy in one Shopify collection, each with a
# clean status on the product (product_type / tags): "Interest Check",
# "Group Buy Is Live", or "In Production". The keyboards pass only reads their
# keyboard collections (and drops keycaps), so these keycap GBs — the interest
# checks especially — were never captured. This pass ingests the interest-check
# and live ones so they reach the Active/Upcoming keycap sections; In Production
# is skipped (that GB is over).
KBDFANS_GB_COLLECTION_URL = "https://kbdfans.com/collections/group-buy/products.json"
KBDFANS_VENDOR_SLUG = "kbdfans"
KBDFANS_ORIGIN = "https://kbdfans.com"


def ensure_kbdfans_vendor(conn) -> str:
    """Return the KBDfans vendor id, creating it (with shipping zones) if needed."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "Vendor" WHERE slug = %s', (KBDFANS_VENDOR_SLUG,))
        row = cur.fetchone()
        if row:
            vendor_id = row["id"]
        else:
            cur.execute("""
                INSERT INTO "Vendor"
                    (id, slug, name, region, country, currency, "websiteUrl", "logoUrl")
                VALUES
                    (gen_random_uuid()::text, %s, 'KBDfans', 'ASIA', 'CN', 'USD', %s, NULL)
                ON CONFLICT (slug) DO UPDATE SET "websiteUrl" = EXCLUDED."websiteUrl"
                RETURNING id
            """, (KBDFANS_VENDOR_SLUG, KBDFANS_ORIGIN))
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


def _kbdfans_tags(product: dict) -> set[str]:
    tags = product.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",")]
    return {str(t).strip().lower() for t in tags if str(t).strip()}


def kbdfans_gb_product_to_set(product: dict) -> dict | None:
    """Turn a KBDfans group-buy product into upsert data, or None to skip.

    Only GMK keycap sets that are an Interest Check or a live Group Buy are
    captured; In Production / anything else is ignored (the GB is no longer
    open). The slug strips the CYL/MTNU profile token so it dedupes against the
    canonical gmk-<colorway> row (same convention as KeycapLendar / zFrontier)."""
    title = (product.get("title") or "").strip()
    if not title:
        return None
    tags = _kbdfans_tags(product)
    ptype = (product.get("product_type") or "").strip().lower()

    # GMK keycaps only — the collection also carries keyboards / deskmats.
    if "gmk keycaps" not in tags and not re.match(r"\s*gmk\b", title, re.I):
        return None

    if ptype == "interest check" or "interest check" in tags:
        status = "INTEREST_CHECK"
    elif ptype in ("group buy is live", "group buy live") or "live" in tags:
        status = "ACTIVE_GB"
    else:
        return None  # In Production / Sold Out / … — the GB is no longer open

    slug = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    slug = re.sub(r"^gmk-(?:cyl-|mx-|mtnu-)", "gmk-", slug)
    if not slug.startswith("gmk"):
        slug = "gmk-" + slug
    if slug in ("gmk", "gmk-"):
        return None

    colorway = re.sub(r"^gmk\s+(?:cyl\s+|mtnu\s+|mx\s+)?", "", title, flags=re.I).strip()
    handle = product.get("handle")
    if not handle:
        return None
    images = product.get("images") or []
    image = images[0].get("src") if images and isinstance(images[0], dict) else None
    return {
        "slug": slug,
        "name": title,
        "colorway": colorway,
        "status": status,
        "imageUrl": image,
        "images": [image] if image else [],
        "productUrl": f"https://kbdfans.com/products/{handle}",
    }


def _kbdfans_merge_status(existing: str | None, incoming: str) -> str:
    """Merge KBDfans' status with what we already have, never regressing.

    - DELIVERED / CANCELLED are terminal: never reactivated.
    - An ACTIVE_GB row is never downgraded to INTEREST_CHECK.
    - incoming ACTIVE_GB promotes any non-terminal row to ACTIVE_GB.
    - incoming INTEREST_CHECK applies only to a blank or already-IC row, so a
      SHIPPING / IN_STOCK row is never pushed back to an interest check."""
    if existing in ("DELIVERED", "CANCELLED"):
        return existing
    if existing == "ACTIVE_GB":
        return "ACTIVE_GB"
    if incoming == "ACTIVE_GB":
        return "ACTIVE_GB"
    if existing in (None, "", "INTEREST_CHECK"):
        return "INTEREST_CHECK"
    return existing


def upsert_kbdfans_gb_set(conn, data: dict, vendor_id: str, norm_index: dict) -> tuple:
    """Create or update a GMK keycap GB from KBDfans and link its buy page.

    Matches an existing row by canonical slug, falling back to a unique
    normalized-name match (so a divergently-slugged catalog row — e.g. gmk.net's
    'gmk-cyl-x-keycaps' — is updated in place instead of duplicated). Status is
    merged so KBDfans never downgrades a live set or reactivates a delivered one.
    Name/colorway/image only fill blanks. Returns (gb_id, created)."""
    slug = data["slug"]
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id, status::text AS status FROM "GroupBuy" WHERE slug = %s', (slug,))
        existing = cur.fetchone()

    if not existing:
        key = normalize_set_name(data["name"])
        cands = norm_index.get(key) or []
        if len(cands) == 1:  # unambiguous only — never risk a wrong merge
            existing = cands[0]

    if existing:
        gb_id = existing["id"]
        new_status = _kbdfans_merge_status(existing.get("status"), data["status"])
        imgs = data.get("images") or []
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE "GroupBuy" SET
                    status = %s::"GBStatus",
                    colorway = CASE WHEN (colorway IS NULL OR colorway = '') THEN %s ELSE colorway END,
                    "imageUrl" = CASE WHEN ("imageUrl" IS NULL OR "imageUrl" = '') AND %s <> '' THEN %s ELSE "imageUrl" END,
                    images = CASE WHEN COALESCE(cardinality(images), 0) = 0 AND cardinality(%s::text[]) > 0 THEN %s::text[] ELSE images END,
                    "updatedAt" = now()
                WHERE id = %s
            """, (new_status, data.get("colorway") or "",
                  data.get("imageUrl") or "", data.get("imageUrl") or "",
                  imgs, imgs, gb_id))
        created = False
    else:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO "GroupBuy"
                    (id, slug, name, colorway, designer, status,
                     "imageUrl", images, "productType", featured, "createdAt", "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, %s, %s, '', %s::"GBStatus",
                     %s, %s, 'KEYCAPS', %s, now(), now())
                ON CONFLICT (slug) DO NOTHING
                RETURNING id
            """, (slug, data["name"], data.get("colorway") or "",
                  data["status"], data.get("imageUrl"),
                  data.get("images") or [], data["status"] == "ACTIVE_GB"))
            row = cur.fetchone()
            if not row:
                cur.execute('SELECT id FROM "GroupBuy" WHERE slug = %s', (slug,))
                row = cur.fetchone()
            gb_id = row["id"]
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO "Kit" (id, name, type, "groupBuyId")
                VALUES (gen_random_uuid()::text, 'Base Kit', 'BASE', %s)
                ON CONFLICT DO NOTHING
            """, (gb_id,))
        created = True
        norm_index.setdefault(normalize_set_name(data["name"]), []).append(
            {"id": gb_id, "status": data["status"]}
        )

    # Link the KBDfans buy page on a KBDfans VendorKit (priced later by run_prices).
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT id FROM "Kit" WHERE "groupBuyId" = %s AND type = \'BASE\' LIMIT 1', (gb_id,))
        kit = cur.fetchone()
    if kit:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO "VendorKit"
                    (id, "kitId", "vendorId", "productUrl", "gbUrl", "inStock", currency, "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, %s, %s, %s, true, 'USD', now())
                ON CONFLICT ("kitId", "vendorId") DO UPDATE SET
                    "productUrl" = EXCLUDED."productUrl",
                    "gbUrl" = EXCLUDED."gbUrl",
                    "updatedAt" = now()
            """, (kit["id"], vendor_id, data["productUrl"], data["productUrl"]))
    return gb_id, created


def run_kbdfans_gb(conn, context: BrowserContext, deadline: float,
                   scrapling: ScraplingClient | None = None) -> dict:
    """Capture GMK keycap interest checks & live group buys from KBDfans."""
    stats = {"products": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}
    log("KBDfans GB pass: capturing GMK keycap interest checks & live group buys ...")
    vendor_id = ensure_kbdfans_vendor(conn)

    # One normalized-name index of existing keycap sets, for divergent-slug dedupe.
    norm_index = build_keycap_norm_index(conn)

    page = context.new_page()
    try:
        products = fetch_collection_products(
            page, KBDFANS_GB_COLLECTION_URL, deadline, scrapling
        )
        stats["products"] = len(products)
        log(f"  Found {len(products)} product(s) in the KBDfans group-buy collection.")
        for product in products:
            if now_ms() > deadline:
                log("KBDfans GB pass: deadline reached — stopping.")
                break
            data = kbdfans_gb_product_to_set(product)
            if not data:
                stats["skipped"] += 1
                continue
            try:
                _, created = upsert_kbdfans_gb_set(conn, data, vendor_id, norm_index)
            except Exception as e:
                log(f"  upsert failed ({data['slug']}): {e}")
                stats["failed"] += 1
                continue
            if created:
                stats["created"] += 1
                log(f"  + {data['name']} ({data['status']} via KBDfans)")
            else:
                stats["updated"] += 1
    except Exception as e:
        log(f"KBDfans GB pass failed: {e}")
        stats["failed"] += 1
    finally:
        page.close()

    log(f"KBDfans GB pass: products={stats['products']} created={stats['created']} "
        f"updated={stats['updated']} skipped={stats['skipped']} failed={stats['failed']}")
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


# ----------------------------------------------------------------------------
# Vendor catalog discovery
#
# Python mirror of discoverGmkProducts() in src/lib/import/discovery.ts. Walks
# each vendor's own Shopify catalog (/products.json), finds every listing titled
# "GMK …", matches it to a set we already track, and wires it up as a scrapeable
# VendorKit so the price pass can price it. This is the new-set / vendor-coverage
# discovery the cloud cron can't do reliably — Shopify Cloudflare blocks Vercel's
# datacenter IPs, but this WorkSpace browser/Scrapling path gets through.
#
# Vendors are scanned oldest-first (Vendor.lastDiscoveredAt), a few per nightly
# run, so the whole roster re-crawls every few days without blowing the budget.
# Existing MANUAL prices are never touched; only the productUrl is (re)linked.
# ----------------------------------------------------------------------------

# Shopify caps products.json at 250/page. This constant has now been raised
# twice for the same reason, so measure before trusting it: 4 pages covered
# every store when it was written, then 8 when Prototypist reached 1500 —
# and as of 2026-08 Prototypist is 4021 products over 17 pages, with 596 of
# its 1081 GMK/DCS listings sitting beyond page 8. (Divinikey is 6 pages,
# KBDfans 2, so nothing else is close.)
#
# 20 costs nothing at a small store: the loop breaks on the first short page,
# so only genuinely large catalogues pay the extra requests — and those are
# spaced by HostThrottle. The cap exists to bound a store that returns a full
# page forever, not to ration reads.
_DISCOVERY_MAX_CATALOG_PAGES = 20
_DISCOVERY_VENDOR_LIMIT = 8

# The rotation's guest list. Two kinds of Vendor row are refused:
#
#   * Manufacturer/catalog sources (gmk.net, dcs.wiki) aren't stores — asking
#     them for a products.json just burns a vendor slot on a 404.
#   * Rows with a BLANK websiteUrl. `_origin_of("")` returns None, so the store
#     is skipped a few lines below — but only AFTER taking one of the eight
#     slots and having lastDiscoveredAt stamped, which also counts it into
#     stats["vendors"]. It reads as "scanned" in the nightly summary while
#     never having been fetched. 26 of the roster's vendors are in that state,
#     so a fifth of every rotation was spent on stores that cannot produce a
#     listing. discovery.ts got this filter in #131; the nightly, which is the
#     pass that actually crawls, did not. db-setup repairs the URLs it can
#     (roster, then each vendor's own listing hosts); the rest are logged.
#   * Rows whose websiteUrl is NOT A SHOP — goo.gl, an Instagram profile, a
#     Google Form, item.taobao.com. Blank is only half of "cannot be crawled":
#     these 404 on /products.json just as reliably, they sort to the FRONT of
#     the rotation (lastDiscoveredAt NULLS FIRST), and until db-setup learned
#     to repair them they were the shape nothing ever revisited, because every
#     repair was keyed on websiteUrl = ''.
#
# The last one is a HOST test, not a substring test — `ILIKE '%x.com%'` also
# matches mybox.com — so the SQL over-fetches and _crawlable_vendors() applies
# it in Python, taking the first _DISCOVERY_VENDOR_LIMIT survivors.
_DISCOVERY_VENDOR_SQL = """
    SELECT id, slug, "websiteUrl", currency
      FROM "Vendor"
     WHERE NOT (slug = ANY(%s))
       AND btrim(coalesce("websiteUrl", '')) <> ''
     ORDER BY "lastDiscoveredAt" ASC NULLS FIRST
     LIMIT %s
"""

# Rows read per rotation slot before the storefront test throws the
# uncrawlable ones away. See DISCOVERY_OVERFETCH in discovery.ts.
_DISCOVERY_OVERFETCH = 4

# Mirror of NON_STOREFRONT_HOSTS in scripts/lib/vendor-urls.mjs — the hosts a
# listing may legitimately live on that are nobody's storefront. Kept in
# agreement by `npm run test:vendor-urls`, which parses both lists: a host that
# exists on one side only is how #131's discovery filter ended up half-applied.
_NON_STOREFRONT_HOSTS = (
    "goo.gl", "bit.ly", "t.co", "tinyurl.com", "linktr.ee",
    "google.com", "docs.google.com", "drive.google.com", "forms.gle",
    "imgur.com", "github.io", "github.com",
    "instagram.com", "facebook.com", "twitter.com", "x.com", "reddit.com",
    "discord.com", "discord.gg", "discord.link", "youtube.com",
    "notion.so", "notion.site",
    "geekhack.org", "deskthority.net",
    "taobao.com", "tmall.com", "aliexpress.com", "alibaba.com", "1688.com",
    "etsy.com", "ebay.com", "amazon.com", "shopee.com", "lazada.com",
    "mercari.com", "kickstarter.com", "indiegogo.com",
    "smartstore.naver.com",
)


def _is_storefront_url(url: str) -> bool:
    """True when `url`'s host is a store's own site, not a marketplace/forum.

    Mirror of isStorefrontHost in scripts/lib/vendor-urls.mjs: only the leading
    "www." is folded away (en.zfrontier.com and www.zfrontier.com are two
    different sites), and a blocked host matches itself or any subdomain of it.
    """
    host = _dcs_host(url or "")
    if not host or "." not in host:
        return False
    return not any(
        host == blocked or host.endswith("." + blocked)
        for blocked in _NON_STOREFRONT_HOSTS
    )


def _crawlable_vendors(rows: list[dict], limit: int) -> tuple[list[dict], list[str]]:
    """Split fetched vendors into the ones worth crawling and the ones refused.

    Returns (vendors, refused_slugs) with at most `limit` vendors — the refused
    ones are named by the caller rather than silently dropped, because a store
    that quietly never gets crawled is exactly how one publishes nothing for a
    year without any run summary looking wrong.
    """
    keep: list[dict] = []
    refused: list[str] = []
    for row in rows:
        if len(keep) >= limit:
            break
        if _is_storefront_url(row.get("websiteUrl") or ""):
            keep.append(row)
        else:
            refused.append(f"{row.get('slug')} ({row.get('websiteUrl')})")
    return keep, refused


def normalize_set_name(name: str) -> str:
    """Mirror of normalizeSetName in discovery.ts — lowercase, drop bracketed
    tags / sale-status / keycap filler words, unify 'Round 3' with 'R3'."""
    s = (name or "").lower()
    s = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", s)
    s = re.sub(
        r"\b(group\s*buy|groupbuy|gb|pre[- ]?order|in[- ]?stock|extras?|live|launch(ed)?)\b",
        " ",
        s,
    )
    # "cyl"/"mtnu" are GMK profile tokens, not set identity: "GMK CYL Seafarer"
    # is the same set as "GMK Seafarer" (vendor outlets and gmk.net both add it).
    #
    # "kit"/"kits" joined the filler list for the same reason "keycap set" is
    # there — it names the packaging, not the product. dcs.wiki calls one set
    # "DCS After School 1992 40s kit" while Prototypist sells the same thing as
    # "DCS After-School 1992 40s Keycap Set"; only "kit" kept those apart.
    # dedupeKey has always treated it as filler; this brings the price matcher
    # into line. Checked against all 1198 tracked set names: zero new
    # collisions. "\bkits?\b" cannot eat "Kitsune" — the boundary requires the
    # token to end there.
    s = re.sub(
        r"\b(keycap\s*sets?|keycaps?|keysets?|kits?|cherry\s*profile|cyl|mtnu)\b", " ", s
    )
    s = re.sub(r"\bround\s*(\d+)\b", r"r\1", s)
    # Drop apostrophes BEFORE punctuation becomes whitespace. Otherwise a
    # vendor's "40's" splits into "40 s" and stops matching the set's "40s" —
    # that is a real miss on Prototypist/KeebzNCables' DCS After School 1992,
    # and on "Li'l Dragon". A trailing possessive ("Davy Jones' Locker") always
    # matched, which is why this stayed hidden.
    s = s.replace("'", "").replace("\u2019", "")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def strip_round(normalized: str) -> str:
    """'gmk striker r2' -> 'gmk striker'; names without a round tag unchanged."""
    return re.sub(r"\s+r\d+$", "", normalized).strip()


# Keycap profiles we track. A vendor listing must name one of these to be
# considered — the profile token is what makes "DCS Dolch" a different product
# from "GMK Dolch", so it is matched here and deliberately kept in the set name.
#
# Mirror of TRACKED_PROFILES in src/lib/set-name.ts, which is where the site's
# maker registry lives — `npm run test:set-name` parses this literal and fails
# if the two disagree. It is deliberately the SAME list rather than a shorter
# one: this gate is the first thing every store product passes through, and
# when it read `\b(?:GMK|DCS)\b` it was narrower than what the site publishes.
#
# MAKER_NAME_PREFIXES carries "SA ", "DSS " and "DSA " because _GH_KEYCAP_PROFILE
# (below) files those Geekhack threads as keycap sets and /browse offers them
# under the Signature Plastics pill; MAKER_SLUG_PREFIXES carries "cyl-"/"mtnu-"
# for the same reason. The sets existed and the site listed them — but a store
# selling them published NOTHING, because tracked_products_from_catalog dropped
# every one of its products before match_product_to_set ever saw a title. A
# Signature Plastics specialist (Saber Keebs: 9 of its 10 keycap products are
# DCS/DSS/SA) came back "0 tracked listing(s)" on every rotation, forever, and
# no run summary ever looked wrong.
#
# Whole-word matching keeps the two-letter tokens safe: "SA" cannot match
# inside "Salamander" or "Sanctuary", both of which are GMK sets.
TRACKED_PROFILES = ("gmk", "cyl", "mtnu", "dcs", "sa", "dss", "dsa")
TRACKED_PROFILE_RE = re.compile(
    r"\b(?:" + "|".join(TRACKED_PROFILES) + r")\b", re.IGNORECASE
)


def catalog_availability(product: dict) -> bool | None:
    """One catalog entry's availability, or None when the entry does not say.

    Mirror of catalogAvailability in scripts/lib/catalog-stock.mjs — keep in
    sync; `npm run test:catalog-stock` fails if they drift.

    THREE answers, not two. "every variant is unavailable" and "this feed does
    not report availability" must never collapse into one False, or a store
    whose feed omits the field gets its whole catalogue marked sold out. This
    used to be `any(v.get("available") for v in variants)`, which returned False
    for both — harmless while the result only broke ties in pick_store_listing,
    and not harmless now that it can clear a listing off the site.

    Ktechs is the worked example: its /products.json reports `available` on
    every variant, while its /products/<handle>.json carries no `available` key
    at all. Same store, same product, and only one of the two endpoints knows.
    """
    variants = product.get("variants") if isinstance(product, dict) else None
    if not isinstance(variants, list):
        return None
    known = False
    any_available = False
    for variant in variants:
        available = variant.get("available") if isinstance(variant, dict) else None
        # Strictly bool: a missing key, None, or the string "false" is NOT a
        # report. `isinstance(True, int)` is True in Python, so this also has to
        # exclude ints explicitly — bool is the only accepted type.
        if not isinstance(available, bool):
            continue
        known = True
        if available:
            any_available = True
    if not known:
        return None
    return any_available


def catalog_stock_update(availability: bool | None) -> bool | None:
    """False when discovery may mark this row sold out, else None (leave alone).

    Mirror of catalogStockUpdate in scripts/lib/catalog-stock.mjs. Takes the
    tri-state from catalog_availability rather than the raw product: the catalog
    parser resolves availability up front (pick_store_listing scores on it), so
    by the time the write happens the raw variants are long gone.

    One-directional on purpose, like the html_guard rule next door:

      * It MAY mark a row sold out. A feed reporting every variant unavailable
        is the store saying nobody can buy this, which is exactly what a stale
        inStock gets wrong.
      * It may NEVER mark a row in stock. "Something on this product is
        purchasable" is not "the BASE variant this row is priced from is
        purchasable" — a listing sold out on the base kit and available on a
        novelty is a common shape. The price pass reads the actual variant and
        is the only authority for True.
    """
    return False if availability is False else None


def tracked_products_from_catalog(data: dict, origin: str) -> list[dict]:
    """Extract [{title, url, available, price}] for every tracked-profile product
    (GMK / DCS …) in a Shopify products.json page. Other profiles and
    handle-less products are dropped.

    `available` and `price` are carried so pick_store_listing() can choose
    between a store's several products for the same set; both are best-effort,
    since a feed may omit either.
    """
    out: list[dict] = []
    for p in (data or {}).get("products", []) or []:
        title = str(p.get("title") or "")
        handle = p.get("handle")
        if not handle or not TRACKED_PROFILE_RE.search(title):
            continue
        variants = p.get("variants") or []
        available = catalog_availability(p)
        price = 0.0
        for v in variants:
            try:
                price = max(price, float(v.get("price")))
            except (TypeError, ValueError):
                continue
        out.append({
            "title": title,
            "url": f"{origin}/products/{handle}",
            "available": available,
            "price": price,
        })
    return out


# Lifecycle words stores put in a product TITLE. Some stores (Prototypist) do
# not flip stock on one product — they publish a new product per stage and keep
# every old one live, so one catalog holds four products for one set:
#
#   (In Stock) GMK CYL Combobreaker    in-stock-…     £123.33  available
#   (Pre-Order) GMK Combobreaker       pre-order-…    £111.67  sold out
#   (Group Buy) GMK Combobreaker       group-buy-…    £106.67  sold out
#   (Coming Soon) GMK Combobreaker     coming-soon-…    £0.00  "available"
#
# They all normalise to the same set, so linking whichever came LAST out of the
# feed pinned the set to a dead page — and worse, non-deterministically, since
# the winner depended on feed order rather than on anything about the listing.
_LISTING_STAGE_SCORES = (
    (re.compile(r"in[\s-]?stock", re.I), 3),
    (re.compile(r"pre[\s-]?order", re.I), 1),
    (re.compile(r"group\s*buy|\bgb\b", re.I), 1),
    (re.compile(r"coming\s*soon|sold\s*out|\bended\b", re.I), -3),
)


def score_store_listing(product: dict) -> float:
    """Rank one store product as the set's canonical listing. Higher wins.

    Strictly tiered, not a weighted sum, because the tiers are not commensurate:

      1. BUYABLE (available AND priced) beats everything. Worth 100 so no
         combination of the weaker signals can outvote it — an early version
         scored this additively and a sold-out "(In Stock) …" could still beat
         an orderable listing, which is the same class of bug this function
         exists to fix.
      2. A REAL PRICE beats mere availability. The "(Coming Soon)" page reports
         available=True at 0.00, so availability alone is the weaker evidence;
         a £0.00 listing is never useful, since the price pass can only store a
         nonsense zero or clear the row.
      3. The TITLE MARKER breaks ties only. Stores word it freely, so it is the
         least trustworthy signal of the three.
    """
    try:
        price = float(product.get("price") or 0)
    except (TypeError, ValueError):
        price = 0.0
    available = bool(product.get("available"))

    score = 0.0
    if available and price > 0:
        score += 100
    if price > 0:
        score += 5
    if available:
        score += 2
    title = str(product.get("title") or "")
    for pattern, weight in _LISTING_STAGE_SCORES:
        if pattern.search(title):
            score += weight
            break
    return score


def pick_store_listing(candidates: list[dict]) -> dict | None:
    """The best of one store's products for a single set, or None if empty.

    Ties keep the FIRST candidate, so the result depends only on the catalog's
    order for listings that genuinely look identical — never on which page of
    the feed a duplicate happened to land on.
    """
    if not candidates:
        return None
    best = candidates[0]
    best_score = score_store_listing(best)
    for candidate in candidates[1:]:
        score = score_store_listing(candidate)
        if score > best_score:
            best, best_score = candidate, score
    return best


# Back-compat alias: the old name described a GMK-only filter.
gmk_products_from_catalog = tracked_products_from_catalog


# ── Generic HTML catalog path (non-Shopify storefronts) ─────────────────────
#
# `/products.json` is a SHOPIFY endpoint, and about a fifth of the roster does
# not run Shopify: Ashkeebs, Zion Studios, Sandkeys and Keyclack are WooCommerce
# (/product/…), CandyKeys serves /group-buys/…, MyKeyboard.eu
# /catalogue/category/…, Latamkeys /productos/, STACKS /store/, KLC Playground
# (KR) and Monstargears are Korean cafe24-style shops, Drop /buy/…, Olkb
# /parts/…. For every one of them the loop in run_discovery reads a 404 on page
# one, marks the catalog unreadable and moves on — so discovery has NEVER
# linked or relinked a single listing for those stores. Their VendorKit rows are
# frozen at whatever the original KeycapLendar import left: a moved or renamed
# group-buy page can never heal, the price pass keeps failing on the dead URL so
# `price` stays NULL, and an unpriced row is hidden outright on a RELEASED set.
# The store publishes nothing at all — and it reads as the first cause in
# db-setup's silent-vendor report ("discovery has never matched a tracked set"),
# which is the same signature the tracked-profile gate produced before #140.
#
# The price pass has handled these stores since generic_price was written; only
# discovery insisted on Shopify. discovery.ts (the Vercel half) has carried the
# fallback below all along, but it fetches from a datacenter IP that these
# stores' bot protection blocks — which is the whole reason this nightly exists.
# So the half that could actually use it was the half that did not have it.
#
# The crawl is deliberately shallow: homepage → up to three GB / pre-order /
# in-stock section pages → every anchor on the store's own site whose TEXT names
# a tracked profile. match_product_to_set stays the real filter, so a category link
# ("GMK Keycaps") simply never resolves to a set.
_DISCOVERY_SECTION_RE = re.compile(
    r"group[\s_-]?buys?|pre[\s_-]?orders?|in[\s_-]?stock", re.IGNORECASE
)
_DISCOVERY_MAX_SECTION_PAGES = 3
_ANCHOR_RE = re.compile(r"<a\b[^>]*href=[\"']([^\"'#]+)[\"'][^>]*>(.*?)</a>", re.I | re.S)
_HTML_TAG_RE = re.compile(r"<[^>]*>")


def _same_site(url: str, origin: str) -> bool:
    """True when `url` is on the storefront's own site.

    Deliberately looser than comparing origins: a Vendor row carries whichever
    spelling of the store someone typed, and it is regularly not the one the
    site serves — `donutcables` and `mechboards` ship as `http://`, `ashkeebs`
    and `keebz-n-cables` as `www.`. Comparing origins would then read every
    anchor on the store's own homepage as somebody else's site and drop it,
    which is the same silent nothing this fallback exists to end. Folds exactly
    what the rest of the codebase folds — scheme and a leading "www." — so
    en.zfrontier.com and www.zfrontier.com stay two different sites.
    """
    host = _dcs_host(url)
    return bool(host) and host == _dcs_host(origin)


def extract_page_links(html: str, base_url: str) -> list[dict]:
    """[{"href", "text"}] for every <a> in `html`, hrefs made absolute.

    Mirror of extractLinks in discovery.ts. Anchor text is stripped of nested
    markup (a product tile wraps its title in <span>/<h3>) and entity-decoded:
    "GMK Black &amp; White" has to normalise to the same key as the set's stored
    name, and normalize_set_name would otherwise keep "amp" as a word.
    """
    links: list[dict] = []
    for match in _ANCHOR_RE.finditer(html or ""):
        text = re.sub(r"\s+", " ", html_unescape(_HTML_TAG_RE.sub(" ", match.group(2)))).strip()
        if not text:
            continue
        try:
            href = urllib.parse.urljoin(base_url, html_unescape(match.group(1)).strip())
        except ValueError:
            continue  # unparseable href — skip
        if not _origin_of(href):
            continue
        links.append({"href": href, "text": text})
    return links


def catalog_section_urls(
    links: list[dict], origin: str, limit: int = _DISCOVERY_MAX_SECTION_PAGES
) -> list[str]:
    """Nav links on the store's own site that name a GB / pre-order / in-stock section.

    Bounded to `limit` pages: this runs for every non-Shopify store in the
    rotation and a storefront's nav can name a dozen collections.
    """
    seen: set[str] = set()
    out: list[str] = []
    for link in links:
        href = link.get("href") or ""
        if not _same_site(href, origin) or href in seen:
            continue
        if not (
            _DISCOVERY_SECTION_RE.search(link.get("text") or "")
            or _DISCOVERY_SECTION_RE.search(href)
        ):
            continue
        seen.add(href)
        out.append(href)
        if len(out) >= limit:
            break
    return out


def tracked_products_from_links(links: list[dict], origin: str) -> list[dict]:
    """Anchors naming a tracked profile (GMK / DCS …), as catalog products.

    Same shape tracked_products_from_catalog returns, so everything downstream —
    pick_store_listing, the subkit guard, the link/relink write — is identical
    for both paths. An HTML listing page carries no stock flag or price, so
    `available` is None and `price` 0.0; score_store_listing then falls back to
    the title marker, which is the only evidence these pages give.
    """
    seen: set[str] = set()
    out: list[dict] = []
    for link in links:
        href = link.get("href") or ""
        text = link.get("text") or ""
        if not _same_site(href, origin) or href in seen:
            continue
        if not TRACKED_PROFILE_RE.search(text):
            continue
        seen.add(href)
        out.append({"title": text, "url": href, "available": None, "price": 0.0})
    return out


def _fetch_page_html(
    page: Page, url: str, scrapling: ScraplingClient | None = None
) -> str | None:
    """One storefront page as HTML — real browser first, Scrapling stealth after."""
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        status = response.status if response is not None else None
        content = page.content()
        if (
            content
            and not response_is_blocked(status, content)
            and (status is None or int(status) < 400)
        ):
            return content
    except Exception as exc:  # noqa: BLE001
        log(f"  html fetch error ({url}): {type(exc).__name__}: {exc}")
    if scrapling is not None and scrapling.available:
        return scrapling.get_html(url, protected=True)
    return None


def html_catalog(
    page: Page,
    origin: str,
    scrapling: ScraplingClient | None = None,
    throttle: "HostThrottle | None" = None,
    deadline: float | None = None,
) -> list[dict]:
    """Catalog products crawled from a non-Shopify storefront's own pages."""
    if throttle is not None:
        throttle.wait(origin)
    home = _fetch_page_html(page, origin, scrapling)
    if not home:
        return []

    home_links = extract_page_links(home, origin)
    pages = [home_links]  # the homepage itself usually lists the current GBs
    for url in catalog_section_urls(home_links, origin):
        if deadline is not None and now_ms() > deadline:
            break
        if throttle is not None:
            throttle.wait(url)
        section = _fetch_page_html(page, url, scrapling)
        if section:
            pages.append(extract_page_links(section, url))

    seen: set[str] = set()
    products: list[dict] = []
    for links in pages:
        for product in tracked_products_from_links(links, origin):
            if product["url"] in seen:
                continue
            seen.add(product["url"])
            products.append(product)
    return products


def relink_price_guard(from_html: bool) -> str:
    """Extra ON CONFLICT condition for a candidate crawled off a storefront.

    A Shopify feed states which product is buyable and what it costs; an anchor
    on a homepage states neither, so an HTML-derived candidate may only take
    over a VendorKit that is NOT currently priced. Unpriced is exactly the state
    the HTML fallback exists to end — an unpriced row is hidden outright on a
    RELEASED set — while a link the price pass is reading successfully is not a
    homepage anchor's to replace. A link that later dies is cleared to NULL by
    the price pass (404/410), which hands the row back to this path on the next
    rotation. Mirrored by `fromHtml` in src/lib/import/discovery.ts.
    """
    if not from_html:
        return ""
    return '\n                          AND "VendorKit".price IS NULL'


def _pick_from_family(candidates: list[dict]) -> dict:
    """ACTIVE round wins, else the newest — vendors sell the current round."""
    if len(candidates) == 1:
        return candidates[0]
    active = [c for c in candidates if c["status"] == "ACTIVE_GB"]
    if len(active) == 1:
        return active[0]
    pool = active if active else candidates
    return max(pool, key=lambda c: c["gbStart"].timestamp() if c["gbStart"] else 0.0)


def match_product_to_set(
    title: str,
    by_full: dict[str, dict],
    by_base: dict[str, list[dict]],
) -> dict | None:
    """Mirror of matchProduct in discovery.ts.

    A title WITH an explicit round ("GMK Striker R2") is unambiguous — exact
    match wins. A BARE title is ambiguous between the ORIGINAL run (whose DB
    row is also unsuffixed) and the CURRENT round: vendors sell the current
    round under the bare name, and exact-matching first attached R2/R3
    listings (and their prices) to the round-1 row. Bare titles therefore
    resolve within the round FAMILY — the round that's selling wins, else the
    newest. Returns None rather than guessing across different sets."""
    full = normalize_set_name(title)
    if not full:
        return None
    if re.search(r"\br\d+$", full):
        exact = by_full.get(full)
        if exact:
            return exact
        candidates = by_base.get(strip_round(full))
        return _pick_from_family(candidates) if candidates else None
    candidates = by_base.get(full)
    if candidates:
        return _pick_from_family(candidates)
    return by_full.get(full)
    # Sort by epoch seconds (0 when undated) so a NULL gbStart can't trigger an
    # aware-vs-naive datetime comparison error on real DB rows.
    return max(pool, key=lambda c: c["gbStart"].timestamp() if c["gbStart"] else 0.0)


def _build_set_index(conn) -> tuple[dict, dict]:
    """Index tracked sets (that have a BASE kit) by normalized name, for
    matching vendor product titles. Returns (by_full, by_base).

    Two DB rows can normalize to the same name (gmk.net's catalog created
    "GMK CYL Kitsune Keycaps" alongside the canonical "GMK Kitsune"). Rows are
    ordered most-vendor-linked first so setdefault keeps the canonical set —
    the one price comparison actually lives on — not the orphan duplicate."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT gb.id, gb.name, gb.status::text AS status, gb."gbStart",
                   k.id AS base_kit_id,
                   (SELECT count(*) FROM "VendorKit" vk
                     WHERE vk."kitId" = k.id) AS vendor_links
              FROM "GroupBuy" gb
              JOIN "Kit" k ON k."groupBuyId" = gb.id AND k.type = 'BASE'
             ORDER BY vendor_links DESC, gb."createdAt" ASC
        """)
        rows = cur.fetchall()
    by_full: dict[str, dict] = {}
    by_base: dict[str, list[dict]] = {}
    for row in rows:
        entry = {
            "group_buy_id": row["id"],
            "base_kit_id": row["base_kit_id"],
            "status": row["status"],
            "gbStart": row["gbStart"],
            # Whether the SET ITSELF is a subkit/accessory product. The
            # dcs.wiki archive catalogs these as first-class sets — DCS Bae
            # Addon, 10U Spacebars, LAE Addon, "After School 1992 40s kit" —
            # so the rule "never link a subkit-looking product" has to know
            # when the subkit IS the product being tracked.
            "is_subkit": bool(_SUBKIT_PRODUCT_RE.search(row["name"] or "")),
        }
        full = normalize_set_name(row["name"])
        if not full:
            continue
        by_full.setdefault(full, entry)
        by_base.setdefault(strip_round(full), []).append(entry)
    return by_full, by_base


def _origin_of(url: str) -> str | None:
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme and parts.netloc:
            return f"{parts.scheme}://{parts.netloc}"
    except Exception:  # noqa: BLE001
        pass
    return None


def run_discovery(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    """Crawl vendor catalogs for GMK listings and link them to tracked sets."""
    stats = {"vendors": 0, "gmk_listings": 0, "linked": 0, "relinked": 0,
             "multi_listing": 0, "html_vendors": 0, "sold_out": 0}

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            _DISCOVERY_VENDOR_SQL,
            (
                list(MANUFACTURER_VENDOR_SLUGS),
                _DISCOVERY_VENDOR_LIMIT * _DISCOVERY_OVERFETCH,
            ),
        )
        vendors, not_shops = _crawlable_vendors(cur.fetchall(), _DISCOVERY_VENDOR_LIMIT)
        # Vendors the query just refused. Naming them is the only signal that a
        # store exists but is unreachable — otherwise it simply never appears.
        cur.execute("""
            SELECT slug FROM "Vendor"
             WHERE btrim(coalesce("websiteUrl", '')) = ''
             ORDER BY slug
        """)
        blank = [r["slug"] for r in cur.fetchall()]
    if blank:
        log(f"Discovery: {len(blank)} vendor(s) have no websiteUrl and cannot be "
            f"crawled — {', '.join(blank)}")
    if not_shops:
        log(f"Discovery: {len(not_shops)} vendor(s) point at a shortener / social / "
            f"marketplace page rather than a storefront and cannot be crawled — "
            f"{', '.join(not_shops)}")
    if not vendors:
        return stats

    by_full, by_base = _build_set_index(conn)
    log(f"Discovery: {len(vendors)} vendor(s) to crawl; "
        f"{len(by_full)} tracked set name(s) indexed.")
    throttle = HostThrottle()
    page = context.new_page()
    try:
        for vendor in vendors:
            if now_ms() > deadline:
                log("Discovery: time budget reached — stopping.")
                break
            # Stamp the attempt up front so a store that hangs or blocks us
            # still rotates to the back of the queue instead of being retried
            # every run.
            with conn.cursor() as cur:
                cur.execute(
                    'UPDATE "Vendor" SET "lastDiscoveredAt" = now() WHERE id = %s',
                    (vendor["id"],),
                )
            conn.commit()
            stats["vendors"] += 1

            origin = _origin_of(vendor["websiteUrl"] or "")
            if not origin:
                continue

            catalog: list[dict] = []
            raw_products = 0
            unreadable = False
            for page_num in range(1, _DISCOVERY_MAX_CATALOG_PAGES + 1):
                url = f"{origin}/products.json?limit=250&page={page_num}"
                throttle.wait(url)
                data = scrapling.get_json(url) if scrapling and scrapling.available else None
                if data is None:
                    try:
                        resp = page.goto(url, wait_until="domcontentloaded",
                                         timeout=NAV_TIMEOUT_MS)
                        if resp is not None and resp.ok:
                            data = json.loads(resp.text())
                    except Exception:  # noqa: BLE001
                        data = None
                if not isinstance(data, dict):
                    # Only the FIRST page failing means we learned nothing;
                    # a later page just ends the catalog.
                    unreadable = page_num == 1
                    break  # not Shopify / blocked / end of catalog
                products = data.get("products") or []
                raw_products += len(products)
                catalog.extend(gmk_products_from_catalog(data, origin))
                if len(products) < 250:
                    break  # last page
                if page_num == _DISCOVERY_MAX_CATALOG_PAGES:
                    # Still a full page at the cap: the catalogue continues and
                    # we are choosing not to read it. Say so rather than let the
                    # shortfall look like the store having nothing.
                    log(f"  {origin}: page cap reached — catalogue continues "
                        f"beyond {raw_products} products.")

            # This loop used to be silent on every failure path, so a run
            # reporting gmk_listings=0 gave no way to tell "every store blocked
            # us" apart from "fetched fine, nothing matched". Say which.
            from_html = False
            if unreadable:
                # No Shopify catalog. That is not "no catalog" — a fifth of the
                # roster runs WooCommerce or a bespoke storefront, and this
                # branch used to `continue`, which is why none of them has ever
                # had a listing linked or relinked (see html_catalog above).
                from_html = True
                catalog = html_catalog(page, origin, scrapling, throttle, deadline)
                if not catalog:
                    log(f"  {origin}: no Shopify catalog and no tracked listing on the "
                        f"storefront's own pages (blocked, or sells none) — skipped.")
                    continue
                stats["html_vendors"] += 1
                log(f"  {origin}: no Shopify catalog — {len(catalog)} tracked "
                    f"listing(s) crawled from the storefront's own pages.")
            elif not catalog:
                log(f"  {origin}: {raw_products} product(s), 0 tracked listing(s).")
                continue
            else:
                log(f"  {origin}: {raw_products} product(s), {len(catalog)} tracked listing(s).")
            stats["gmk_listings"] += len(catalog)

            # Group first, write second. A store can list the same set several
            # times (see pick_store_listing) and writing as we go meant the LAST
            # match won, which is how sets ended up pinned to dead
            # "(Coming Soon)" pages. Collect every candidate per kit, then link
            # the best one exactly once.
            by_kit: dict[str, dict] = {}
            for product in catalog:
                match = match_product_to_set(product["title"], by_full, by_base)
                if not match:
                    continue
                # Subkit/accessory products are never a normal set's base
                # listing: "GMK Foo (Novelties)" normalises to "gmk foo" once
                # the bracket is stripped, so without this it would hijack the
                # base listing of GMK Foo.
                #
                # But the test used to run BEFORE matching, which made it
                # unconditional — and dcs.wiki catalogs subkits as sets in their
                # own right. Every such set (DCS Bae Addon, 10U Spacebars, LAE
                # Addon, After School 1992 40s kit) was therefore unlinkable by
                # discovery: the only products that could match them are exactly
                # the ones being skipped. Apply the guard only when the matched
                # SET is not itself a subkit.
                if _SUBKIT_PRODUCT_RE.search(product["title"]) and not match["is_subkit"]:
                    continue
                bucket = by_kit.setdefault(
                    match["base_kit_id"], {"match": match, "products": []}
                )
                bucket["products"].append(product)

            for bucket in by_kit.values():
                match = bucket["match"]
                product = pick_store_listing(bucket["products"])
                if product is None:
                    continue
                if len(bucket["products"]) > 1:
                    stats["multi_listing"] += 1
                    others = len(bucket["products"]) - 1
                    log(f"    {others + 1} listings for one set — chose "
                        f"{product['url'].rsplit('/', 1)[-1]} over {others} other(s)")
                # Create the link if missing, or refresh a changed productUrl —
                # but never touch a MANUAL price's row. RETURNING (xmax = 0)
                # distinguishes an insert (new link) from an update (relink); a
                # skipped MANUAL/unchanged row returns nothing.
                #
                # A candidate crawled off a storefront's own HTML may only take
                # over a row that is NOT currently priced. A Shopify feed says
                # which product is buyable and what it costs; an anchor on a
                # homepage says neither, so it cannot be trusted to outrank a
                # link the price pass is successfully reading. Unpriced is
                # exactly the state this fallback exists to end — and a link
                # that later dies is cleared to NULL by the price pass (404/410),
                # which hands the row back to this branch on the next rotation.
                html_guard = relink_price_guard(from_html)
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute(f"""
                        INSERT INTO "VendorKit"
                            (id, "kitId", "vendorId", "productUrl", "gbUrl",
                             "inStock", currency, "updatedAt")
                        VALUES
                            (gen_random_uuid()::text, %s, %s, %s, %s, true, %s, now())
                        ON CONFLICT ("kitId", "vendorId") DO UPDATE SET
                            "productUrl" = EXCLUDED."productUrl",
                            "gbUrl" = COALESCE("VendorKit"."gbUrl", EXCLUDED."gbUrl"),
                            -- The stored price belongs to the OLD url; leaving
                            -- it would keep showing the dead listing's "sold
                            -- out" until this row's turn came round again.
                            -- Nulling it re-queues the row for tonight's price
                            -- pass, which runs after discovery. Only ever
                            -- reached when the url actually changed (below).
                            "priceUpdatedAt" = NULL,
                            "updatedAt" = now()
                        WHERE "VendorKit"."priceSource" IS DISTINCT FROM 'MANUAL'
                          AND "VendorKit"."productUrl" IS DISTINCT FROM EXCLUDED."productUrl"{html_guard}
                        RETURNING (xmax = 0) AS inserted
                    """, (
                        match["base_kit_id"], vendor["id"], product["url"],
                        product["url"], vendor["currency"],
                    ))
                    row = cur.fetchone()
                conn.commit()
                # Stock, separately from the link. The upsert above only
                # fires when the productUrl CHANGED, so a listing the store has
                # ended keeps whatever inStock it had — and inStock is DEFAULT
                # true, so "ended a year ago" reads as buyable until the
                # time-boxed price pass happens to reach the row. The feed we
                # just read says so outright: ktechs.store reports GMK CYL
                # Thunder God as available=false on every variant.
                #
                # One direction only (catalog_stock_update): a feed may mark a
                # row SOLD OUT, never in stock. "Something on this product is
                # purchasable" is not "the BASE variant this row is priced from
                # is purchasable", and the price pass owns that answer. An
                # unreported availability is None and writes nothing at all.
                sold_out = catalog_stock_update(product.get("available"))
                if sold_out is False:
                    with conn.cursor() as cur:
                        cur.execute("""
                            UPDATE "VendorKit" SET "inStock" = false, "updatedAt" = now()
                             WHERE "kitId" = %s AND "vendorId" = %s
                               AND "inStock" IS DISTINCT FROM false
                               AND "priceSource" IS DISTINCT FROM 'MANUAL'
                        """, (match["base_kit_id"], vendor["id"]))
                        if cur.rowcount:
                            stats["sold_out"] += cur.rowcount
                    conn.commit()

                if row is None:
                    continue  # MANUAL or unchanged — nothing to do
                if row["inserted"]:
                    stats["linked"] += 1
                else:
                    stats["relinked"] += 1
    finally:
        page.close()
    log(f"Discovery -> vendors={stats['vendors']} "
        f"gmk_listings={stats['gmk_listings']} linked={stats['linked']} "
        f"relinked={stats['relinked']} multi_listing={stats['multi_listing']} "
        f"sold_out={stats['sold_out']} html_vendors={stats['html_vendors']}")
    return stats


def generic_price(
    page: Page,
    product_url: str,
    vendor_currency: str | None,
    scrapling: ScraplingClient | None = None,
    allow_subkits: bool = False,
) -> dict | None:
    """Price path for non-Shopify storefronts (WooCommerce: Latamkeys, STACKS).

    Mirrors shopify_price's contract — returns a price dict, DEAD_LINK (the
    store says the page is gone), NO_BASE_KIT (read fine, nothing to price, so
    clear it), PRICE_REFUSED (read fine, and this site refused the number),
    NO_PRODUCT_DATA (200 with no product markup any parser knows) or None
    (transient, keep the last good price). Prefers the
    WooCommerce variation blob so the base kit is picked over a cheaper subkit;
    falls back to a single JSON-LD offer for simple products."""
    status: int | None = None
    html: str | None = None
    # Where the navigation ended — None when the browser never got there, so a
    # page Scrapling fetched instead is never judged on a stale page.url.
    final_url: str | None = None
    # Why the navigation failed, when it did: a DNS failure is the store saying
    # "gone" and every other error is a block. See is_gone_host_error.
    nav_error: Exception | None = None
    try:
        response = page.goto(
            product_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS
        )
        status = response.status if response is not None else None
        final_url = page.url
        content = page.content()
        if content and not response_is_blocked(status, content):
            html = content
    except Exception as exc:  # noqa: BLE001
        nav_error = exc
        log(f"  generic fetch error ({product_url}): {type(exc).__name__}: {exc}")

    if html is None and scrapling is not None and scrapling.available:
        html = scrapling.get_html(product_url, protected=True)

    if not html:
        # A genuinely removed listing (404/410) clears the stale price; a
        # transient block keeps the last good price (same split as Shopify).
        if status in DEAD_LINK_STATUSES:
            log(f"  dead link ({status}) — clearing price ({product_url})")
            return DEAD_LINK
        # …and the answer that never produced a status at all: the host has
        # stopped resolving. Claimed only when no transport got a page — if
        # Scrapling reached the site, the domain is alive and the browser was
        # merely blocked.
        if is_gone_host_error(nav_error):
            log(f"  dead link (host does not resolve) — clearing price ({product_url})")
            return DEAD_LINK
        return None

    # The store answered, but with its front door rather than this page — how a
    # removed WooCommerce product and an acquired domain both answer, and never
    # a status the pass could read. Checked BEFORE the markup is parsed: a home
    # page carrying Product markup of its own would otherwise be scraped and
    # published as this set's price at this vendor.
    if is_gone_redirect(product_url, final_url):
        log(f"  dead link (redirected to {final_url}) — clearing price ({product_url})")
        return DEAD_LINK

    if vendor_currency and vendor_currency not in _SUPPORTED_CURRENCIES:
        # Read fine; this site cannot convert the money. A refusal by us, not a
        # link the pass could not reach — rationalkeys.com.tr sells in TRY and
        # spent a year reported as "the price pass has never read one".
        log(f"  unsupported currency {vendor_currency} — refused ({product_url})")
        return PRICE_REFUSED

    # WooCommerce variable product: pick the base kit, not the cheapest subkit.
    variants = parse_woocommerce_variations(html)
    if variants:
        chosen = choose_kit_variant(variants, allow_subkits=allow_subkits)
        if chosen is None:
            # Only subkits on offer — clear so the wrong number stops showing.
            return NO_BASE_KIT
        if not is_plausible_base_price(chosen["price"], vendor_currency):
            log(
                f"  implausible kit price {chosen['price']} {vendor_currency}"
                f" — refused ({product_url})"
            )
            return PRICE_REFUSED
        return {
            "price": chosen["price"],
            "currency": vendor_currency,
            "variants": [
                {
                    "title": v["title"],
                    "price": v["price"],
                    "available": bool(v.get("available", True)),
                }
                for v in variants
            ],
            "inStock": bool(chosen.get("available", True)),
        }

    # Simple product: single JSON-LD offer.
    offer = parse_jsonld_offer(html)
    if offer is None:
        # The page answered and carries no product markup any parser path here
        # knows — an unreadable platform, a placeholder page, or a bot check
        # served as a 200. Distinct from None so the row records what was
        # learned instead of reading as a link nobody could reach.
        return NO_PRODUCT_DATA
    if offer is NO_BASE_KIT:
        # Ambiguous multi-kit aggregate or a lone subkit/accessory offer —
        # clear the stale price rather than store/keep a non-base number.
        return NO_BASE_KIT
    if not is_plausible_base_price(offer["price"], vendor_currency):
        log(
            f"  implausible kit price {offer['price']} {vendor_currency}"
            f" — refused ({product_url})"
        )
        return PRICE_REFUSED
    return {
        "price": offer["price"],
        "currency": vendor_currency,
        "variants": [],
        "inStock": offer["available"],
    }


# ----------------------------------------------------------------------------
# GMK direct sale (gmk.net Warehouse Finds)
#
# GMK now sells discounted sets DIRECTLY on gmk.net: the "GMK Warehouse Finds"
# Shopware product carries an "Available Sets" variant configurator where each
# option is a specific kit ("Lazurite Base Set", "Moonlight Spacebars Kit", …)
# with its own price; sold-out options are rendered disabled. The 'gmk' vendor
# row stays the never-priced MANUFACTURER, so these purchasable listings live
# under a separate real vendor, 'gmk-direct' (EUR), whose prices this pass
# writes itself — gmk.net is Shopware, so the Shopify price pass can't touch it
# (fetch_price_candidates already skips gmk.net URLs).
#
# Flow, all plain HTTP (validated live): parent page → parse options → variant
# switch endpoint (?switched=<group>&options={group:option}) → variant URL →
# variant page's buy-box price. Only "... Base Set" options are priced; subkit
# options are ignored, and a sold-out Base Set clears the price (inStock=false).
# ----------------------------------------------------------------------------
GMK_DIRECT_PAGES = [
    "https://www.gmk.net/shop/en/gmk-warehouse-finds/fptk1339",
]
GMK_DIRECT_VENDOR_SLUG = "gmk-direct"

_GMK_WF_OPTION_RE = re.compile(
    r'<input type="radio"\s+name="([0-9a-f]+)"\s+value="([0-9a-f]+)"\s+'
    r'class="([^"]*)"[\s\S]{0,900}?title="([^"]+)"'
)
_GMK_WF_SWITCH_RE = re.compile(r'data-variant-switch-options="([^"]+)"')
# Price inside the buy box only — the header cart also renders €0.00 amounts.
_GMK_WF_PRICE_RE = re.compile(
    r'product-detail-price-container[\s\S]{0,300}?itemprop="price"\s+content="([0-9][0-9.]*)"'
)
_GMK_WF_PRICE_TEXT_RE = re.compile(
    r'product-detail-price"\s*>\s*€\s*([0-9][0-9,.]*)'
)
_GMK_WF_BASE_RE = re.compile(r"^(.+?)\s+(?:Latin\s+)?Base\s+Set$", re.IGNORECASE)


def gmk_wf_parse_options(html_doc: str) -> tuple[str | None, list[dict]]:
    """Parse the Warehouse Finds configurator.

    Returns (switch_url, options); each option is
    {group, option_id, label, available}. A disabled radio means the kit is
    sold out at GMK."""
    switch_url = None
    m = _GMK_WF_SWITCH_RE.search(html_doc)
    if m:
        try:
            switch_url = json.loads(html_unescape(m.group(1))).get("url")
        except (json.JSONDecodeError, AttributeError, TypeError):
            switch_url = None
    options = []
    for group, option_id, cls, title in _GMK_WF_OPTION_RE.findall(html_doc):
        options.append({
            "group": group,
            "option_id": option_id,
            "label": html_unescape(title).strip(),
            "available": "disabled" not in cls,
        })
    return switch_url, options


def gmk_wf_base_set_name(label: str) -> str | None:
    """'Lazurite Base Set' -> 'GMK Lazurite'; subkit labels -> None.

    'Zen Pond Latin Base Set' drops the legends qualifier too. The GMK prefix
    is added because gmk.net options omit the brand our set names carry."""
    m = _GMK_WF_BASE_RE.match(label.strip())
    return f"GMK {m.group(1)}" if m else None


def gmk_wf_price_from_html(html_doc: str) -> float | None:
    """The variant page's buy-box price in EUR, sanity-bounded."""
    m = _GMK_WF_PRICE_RE.search(html_doc)
    if not m:
        m = _GMK_WF_PRICE_TEXT_RE.search(html_doc)
    if not m:
        return None
    try:
        price = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    # A GMK base kit, even clearance-priced, lives well inside this window.
    return price if 10 <= price <= 500 else None


def ensure_gmk_direct_vendor(conn) -> str:
    """Upsert the purchasable GMK Direct vendor (distinct from the 'gmk'
    manufacturer row). Shipping zones are seeded by the daily cron's
    ensureShippingZonesForAllVendors, same as every scraper-created vendor."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            INSERT INTO "Vendor"
                (id, slug, name, region, country, currency, "websiteUrl")
            VALUES
                (gen_random_uuid()::text, %s, 'GMK Direct', 'EU', 'DE', 'EUR',
                 'https://www.gmk.net/shop/en/')
            ON CONFLICT (slug) DO UPDATE SET "websiteUrl" = EXCLUDED."websiteUrl"
            RETURNING id
        """, (GMK_DIRECT_VENDOR_SLUG,))
        row = cur.fetchone()
    conn.commit()
    return row["id"]


def run_gmk_direct(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    """Price gmk.net Warehouse Finds base sets under the GMK Direct vendor."""
    stats = {"pages": 0, "base_options": 0, "priced": 0,
             "out_of_stock": 0, "unmatched": 0}
    vendor_id = ensure_gmk_direct_vendor(conn)
    by_full, by_base = _build_set_index(conn)
    page = context.new_page()

    def fetch_text(url: str) -> str | None:
        if scrapling and scrapling.available:
            body = scrapling.get_html(url)
            if body:
                return body
        try:
            resp = page.goto(url, wait_until="domcontentloaded",
                             timeout=NAV_TIMEOUT_MS)
            if resp is not None and resp.ok:
                return page.content()
        except Exception:  # noqa: BLE001
            pass
        return None

    def upsert(kit_id: str, price: float | None, in_stock: bool, url: str) -> None:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO "VendorKit"
                    (id, "kitId", "vendorId", price, currency, "inStock",
                     "productUrl", "gbUrl", "priceUpdatedAt", "priceSource", "updatedAt")
                VALUES
                    (gen_random_uuid()::text, %s, %s, %s, 'EUR', %s, %s, %s, now(), 'SCRAPED', now())
                ON CONFLICT ("kitId", "vendorId") DO UPDATE SET
                    price = EXCLUDED.price,
                    currency = 'EUR',
                    "inStock" = EXCLUDED."inStock",
                    "productUrl" = EXCLUDED."productUrl",
                    "gbUrl" = COALESCE("VendorKit"."gbUrl", EXCLUDED."gbUrl"),
                    "priceUpdatedAt" = now(),
                    "priceSource" = 'SCRAPED',
                    "updatedAt" = now()
                WHERE "VendorKit"."priceSource" IS DISTINCT FROM 'MANUAL'
            """, (kit_id, vendor_id, price, in_stock, url, url))
        conn.commit()

    try:
        for parent_url in GMK_DIRECT_PAGES:
            if now_ms() > deadline:
                log("GMK Direct: time budget reached — stopping.")
                break
            doc = fetch_text(parent_url)
            if not doc:
                log(f"GMK Direct: could not read {parent_url} — skipped.")
                continue
            stats["pages"] += 1
            switch_url, options = gmk_wf_parse_options(doc)

            for opt in options:
                if now_ms() > deadline:
                    break
                set_name = gmk_wf_base_set_name(opt["label"])
                if not set_name:
                    continue  # novelties/spacebars/etc — base sets only
                stats["base_options"] += 1
                match = match_product_to_set(set_name, by_full, by_base)
                if not match:
                    stats["unmatched"] += 1
                    log(f"  warehouse option not matched to a set: {opt['label']}")
                    continue

                if not opt["available"]:
                    # Sold out at GMK — keep the row but clear the price.
                    upsert(match["base_kit_id"], None, False, parent_url)
                    stats["out_of_stock"] += 1
                    continue

                variant_url = parent_url
                if switch_url:
                    params = urllib.parse.urlencode({
                        "switched": opt["group"],
                        "options": json.dumps({opt["group"]: opt["option_id"]}),
                    })
                    body = fetch_text(f"{switch_url}?{params}")
                    if body:
                        try:
                            m = re.search(r'\{[^{}]*"url"[^{}]*\}', body)
                            switched = json.loads(html_unescape(m.group(0))) if m else None
                            if switched and switched.get("url"):
                                variant_url = switched["url"]
                        except (json.JSONDecodeError, AttributeError):
                            pass

                vdoc = doc if variant_url == parent_url else fetch_text(variant_url)
                price = gmk_wf_price_from_html(vdoc or "")
                if price is None:
                    log(f"  no price found for {opt['label']} ({variant_url})")
                    continue
                upsert(match["base_kit_id"], price, True, variant_url)
                stats["priced"] += 1
                log(f"  GMK Direct priced: {opt['label']} -> EUR {price} ({variant_url})")
    finally:
        page.close()

    log(f"GMK Direct -> pages={stats['pages']} base_options={stats['base_options']} "
        f"priced={stats['priced']} out_of_stock={stats['out_of_stock']} "
        f"unmatched={stats['unmatched']}")
    return stats


# ----------------------------------------------------------------------------
# Vendor outlet / clearance collections
#
# Discounted GMK restocks live in dedicated vendor collections (e.g. iLumKB's
# "🔥 GMK Outlet"). Each outlet product carries labeled Base/Novelties/...
# variants at the discounted price, so the regular price pass prices them
# correctly — the missing link is pointing the set's VendorKit at the OUTLET
# listing instead of the (often dead or full-price) regular one. This pass
# matches each outlet product to a tracked set, relinks the vendor's kit row,
# and clears priceUpdatedAt so the same night's price pass re-prices it at the
# discount (main() runs discovery → outlets → prices in that order, so the
# outlet link always wins the night). MANUAL prices are never touched.
# ----------------------------------------------------------------------------
# Surveyed from every vendor's /collections.json (2026-08): 12 of 13 stores run
# a standing clearance/sale collection. Only stable handles are listed —
# KBDfans' are dated ("2025-mid-autumn-festival-sale-keycaps") and rot within a
# season, and Oblotzky runs none at all.
#
# Entries are URLs only. The old form keyed each one by a hardcoded vendor slug,
# which silently skips ("vendor not in DB") whenever the guess is wrong; the
# vendor is now resolved from the URL's host against Vendor.websiteUrl, so a
# collection can only fail loudly on the fetch itself.
#
# Pages per collection. 4 × 250 = 1000 products covers every collection
# measured (the largest, Prototypist's streamsale, is 397) with headroom, while
# still bounding a store that returns the same page forever.
_OUTLET_MAX_PAGES = 4

OUTLET_COLLECTIONS = [
    # iLumKB — the original entry; the emoji handle is percent-encoded.
    "https://ilumkb.com/collections/%F0%9F%94%A5-gmk-outlet/products.json",
    "https://ilumkb.com/collections/last-chance/products.json",
    "https://ilumkb.com/collections/on-sale/products.json",
    # NovelKeys — richest source: a GMK-specific discount collection plus the
    # leftovers listing this pass exists to catch.
    "https://novelkeys.com/collections/discounted-gmk/products.json",
    "https://novelkeys.com/collections/in-stock-gmk-leftovers/products.json",
    "https://novelkeys.com/collections/clearance/products.json",
    "https://novelkeys.com/collections/base-kit-sale/products.json",
    "https://cannonkeys.com/collections/clearance/products.json",
    "https://cannonkeys.com/collections/clearance-nicepbt-cannoncaps/products.json",
    "https://unikeyboards.com/collections/keycap-sale-collection/products.json",
    "https://unikeyboards.com/collections/currently-on-sale/products.json",
    "https://prototypist.net/collections/last-chance/products.json",
    "https://prototypist.net/collections/in-stock-streamsale/products.json",
    # Prototypist mints a NEW Shopify product at every lifecycle stage —
    # coming-soon-… → group-buy-… → in-stock-… — rather than flipping stock on
    # one. So a VendorKit linked during the group buy stays pointed at a handle
    # that is now permanently sold out, and the price pass faithfully reports
    # "sold out" forever. Measured 2026-08: 95 in-stock keycap listings on the
    # store, 25 linked on the site; GMK Combobreaker was pinned to
    # coming-soon-gmk-combobreaker while in-stock-gmk-cyl-combobreaker sold at
    # £123.33. Relinking is exactly what this pass does.
    "https://prototypist.net/collections/in-stock-gmk/products.json",
    "https://prototypist.net/collections/in-stock-signature-plastics-keysets/products.json",
    "https://prototypist.net/collections/summer-sale-2026/products.json",
    # Keebz n Cables (AU) — the two in-stock keycap collections.
    "https://www.keebzncables.com/collections/gmk-keycaps-in-stock/products.json",
    "https://www.keebzncables.com/collections/keycaps-in-stock-1/products.json",
    # Yushakobo (JP) — its GMK collection; the store-wide catalog is mostly
    # switches and parts, so the collection is the cheaper, denser fetch.
    "https://shop.yushakobo.jp/collections/gmk/products.json",
    # Saber Keebs (US) — a Signature Plastics specialist: 9 of its 10 keycap
    # products are DCS/DSS/SA, which is why it earns a slot despite the small
    # catalog. Vendor row seeded by ensure_seeded_vendors().
    "https://saberkeebs.com/collections/keycap-sets/products.json",
    "https://ktechs.store/collections/warehouse-clearance/products.json",
    # Ktechs' standing GMK collection (19 sets), not a clearance page. It is
    # here because discovery rotates only _DISCOVERY_VENDOR_LIMIT stores per
    # run, so a listing published between a store's turns waits days to be
    # linked — GMK Hanami Dango went up 2026-08-07 at $88 (a single
    # "Base + Novelties" variant) and was still unlinked the next day. Outlets
    # runs EVERY collection every night, so a GMK-only collection listed here
    # is checked on every run regardless of the discovery rotation.
    "https://ktechs.store/collections/gmk/products.json",
    "https://pantheonkeys.com/collections/clearance/products.json",
    "https://clickclack.io/collections/sale/products.json",
    "https://klc-playground.com/collections/black-friday/products.json",
    # Geonworks' "gmk-leftover-collection" still resolves but is EMPTY (0
    # products, checked 2026-08) — the store moved its stock to /collections/gmk.
    # An empty collection reads exactly like a working one in the run summary,
    # which is why it went unnoticed.
    "https://geon.works/collections/gmk/products.json",
    "https://www.matrixlab.store/collections/flash/products.json",
]


# Stores that OUTLET_COLLECTIONS references but that no other pass creates.
#
# Vendor rows are normally born from an import or from discovery crawling a
# store the catalog already mentions, so a shop nobody links to yet never gets
# one — and run_outlets resolves vendors by HOST, so its collection would log
# "no tracked vendor" every night and quietly do nothing. Seeding here keeps the
# collection list and the vendor roster from drifting apart.
#
# The websiteUrl is also REPOINTED on an existing row, the same way
# ensure_zfrontier_vendor does — a vendor whose stored origin 404s is invisible
# to discovery (which fetches "{origin}/products.json") and to run_outlets
# (which resolves collections by host), and nothing else ever corrects it.
#
# (slug, name, region, country, currency, websiteUrl)
SEEDED_VENDORS = [
    (
        "saber-keebs", "Saber Keebs", "US", "US", "USD",
        "https://saberkeebs.com",
    ),
    # Yushakobo's storefront is the shop SUBDOMAIN: yushakobo.jp/products.json
    # is a 404 while shop.yushakobo.jp/products.json serves the catalog, and
    # host matching strips "www." but not "shop.", so a row pointed at the bare
    # domain silently fails both passes.
    #
    # That is one instance of a general shape — a Vendor row parked alone on a
    # storefront that is not this store's site — which db-setup now repairs from
    # the row's own listing URLs (planStorefrontRelocation in
    # scripts/lib/vendor-urls.mjs; it moves this very row). This entry stays
    # because it also CREATES the row on a database that has never seen it, and
    # a store with no VendorKit rows yet has nothing to derive a host from.
    (
        "yushakobo", "Yushakobo", "ASIA", "JP", "JPY",
        "https://shop.yushakobo.jp",
    ),
]


def ensure_seeded_vendors(conn) -> int:
    """Create or repoint the SEEDED_VENDORS rows. Returns how many were created.

    Shipping zones are deliberately NOT seeded: computeCheapest() falls back to
    the DHL lane estimate when a zone row is missing, whereas a wrong hardcoded
    zone would quietly misprice every listing. The nightly backfillShipping in
    db-setup fills real zones in later.

    The Vendor table has no createdAt/updatedAt columns — naming them in an
    insert has broken a nightly run before.
    """
    created = 0
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        for slug, name, region, country, currency, website in SEEDED_VENDORS:
            cur.execute("""
                INSERT INTO "Vendor"
                    (id, slug, name, region, country, currency, "websiteUrl", "logoUrl")
                VALUES
                    (gen_random_uuid()::text, %s, %s, %s::"Region", %s, %s, %s, NULL)
                ON CONFLICT (slug) DO UPDATE SET
                    "websiteUrl" = EXCLUDED."websiteUrl"
                RETURNING (xmax = 0) AS inserted
            """, (slug, name, region, country, currency, website))
            row = cur.fetchone()
            if row and row.get("inserted"):
                created += 1
                log(f"Vendors: seeded {name} ({website}).")
    conn.commit()
    return created


def run_outlets(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    """Relink VendorKits to vendors' outlet/clearance listings."""
    stats = {"collections": 0, "products": 0, "linked": 0, "skipped_hosts": 0}
    # Before the host lookups below, or a seeded store's collection is skipped
    # on the very run that introduces it.
    ensure_seeded_vendors(conn)
    by_full, by_base = _build_set_index(conn)
    # Paging multiplied this pass's request count, and OUTLET_COLLECTIONS is
    # grouped by store — five consecutive Prototypist collections is exactly the
    # host-clustered burst that reads as abuse. Interleave first so consecutive
    # requests hit different stores, then throttle what's left.
    collections = [
        row["productUrl"]
        for row in HostThrottle.interleave(
            [{"productUrl": u} for u in OUTLET_COLLECTIONS]
        )
    ]
    throttle = HostThrottle()
    page = context.new_page()
    try:
        for url in collections:
            if now_ms() > deadline:
                log("Outlets: time budget reached — stopping.")
                break
            # Resolve the vendor from the collection's HOST rather than a
            # hardcoded slug: a wrong slug skips silently, a wrong host does not
            # exist to get wrong.
            vendor_id = find_vendor_for_url(conn, url)
            if not vendor_id:
                # Counted, not just logged: a host that silently resolves to
                # nothing is how a whole store's collection goes unscraped for
                # weeks without the run summary ever looking wrong.
                stats["skipped_hosts"] += 1
                log(f"Outlets: no tracked vendor for {_dcs_host(url)} — skipped.")
                continue
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    'SELECT id, currency FROM "Vendor" WHERE id = %s',
                    (vendor_id,),
                )
                vendor = cur.fetchone()
            if not vendor:
                continue

            # Paginated: Shopify caps a collection feed at 250 per page, and
            # this pass read only the first one. Prototypist's streamsale
            # (397 products) and summer sale (318) were each losing their tail
            # silently — a full page is indistinguishable from a small
            # collection unless you ask for the next one.
            products: list[dict] = []
            unreadable = False
            for page_num in range(1, _OUTLET_MAX_PAGES + 1):
                fetch_url = f"{url}?limit=250&page={page_num}"
                throttle.wait(fetch_url)
                data = (
                    scrapling.get_json(fetch_url)
                    if scrapling and scrapling.available
                    else None
                )
                if data is None:
                    try:
                        resp = page.goto(fetch_url, wait_until="domcontentloaded",
                                         timeout=NAV_TIMEOUT_MS)
                        if resp is not None and resp.ok:
                            data = json.loads(resp.text())
                    except Exception:  # noqa: BLE001
                        data = None
                if not isinstance(data, dict):
                    # Page 1 unreadable is a failed collection; a later page
                    # failing still leaves the earlier ones worth processing.
                    if page_num == 1:
                        unreadable = True
                    break
                batch = data.get("products") or []
                products.extend(batch)
                # A short page is the last page.
                if len(batch) < 250:
                    break
            else:
                log(f"Outlets: {_dcs_host(url)} collection hit the "
                    f"{_OUTLET_MAX_PAGES}-page cap — tail not read.")
            if unreadable:
                log(f"Outlets: could not read {url} — skipped.")
                continue
            stats["collections"] += 1

            origin = _origin_of(url) or ""
            for product in products:
                title = str(product.get("title") or "")
                handle = product.get("handle")
                if not handle:
                    continue
                stats["products"] += 1
                match = match_product_to_set(title, by_full, by_base)
                if not match:
                    log(f"  outlet product not matched to a set: {title[:60]}")
                    continue
                # Outlet collections list base and subkits as separate products,
                # and only a base listing may take over a normal set's link.
                # A set that IS a subkit (dcs.wiki catalogs several) is the one
                # case where the subkit product is the right listing — same rule
                # as run_discovery, and it has to run AFTER matching to know.
                if _SUBKIT_PRODUCT_RE.search(title) and not match["is_subkit"]:
                    continue
                product_url = f"{origin}/products/{handle}"
                # Relink to the outlet listing and clear priceUpdatedAt so the
                # price pass (which runs after this) re-prices it tonight. The
                # base/subkit split is the price pass's job — its variant
                # classifier picks the labeled Base kit off the outlet listing.
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("""
                        INSERT INTO "VendorKit"
                            (id, "kitId", "vendorId", "productUrl", "gbUrl",
                             "inStock", currency, "updatedAt")
                        VALUES
                            (gen_random_uuid()::text, %s, %s, %s, %s, true, %s, now())
                        ON CONFLICT ("kitId", "vendorId") DO UPDATE SET
                            "productUrl" = EXCLUDED."productUrl",
                            "gbUrl" = COALESCE("VendorKit"."gbUrl", EXCLUDED."gbUrl"),
                            "priceUpdatedAt" = NULL,
                            "updatedAt" = now()
                        WHERE "VendorKit"."priceSource" IS DISTINCT FROM 'MANUAL'
                          AND "VendorKit"."productUrl" IS DISTINCT FROM EXCLUDED."productUrl"
                        RETURNING id
                    """, (
                        match["base_kit_id"], vendor["id"], product_url,
                        product_url, vendor["currency"],
                    ))
                    row = cur.fetchone()
                conn.commit()
                if row is not None:
                    stats["linked"] += 1
                    log(f"  outlet linked: {title[:60]} -> {product_url}")
    finally:
        page.close()
    log(f"Outlets -> collections={stats['collections']} "
        f"products={stats['products']} linked={stats['linked']} "
        f"skipped_hosts={stats['skipped_hosts']}")
    return stats


def run_prices(
    conn,
    context: BrowserContext,
    deadline: float,
    scrapling: ScraplingClient | None = None,
) -> dict:
    stats = {"attempted": 0, "updated": 0, "failed": 0, "dead": 0,
             "refused": 0, "unparsed": 0, "throttled_s": 0.0}
    ensure_link_health_columns(conn)
    candidates = HostThrottle.interleave(fetch_price_candidates(conn))
    log(f"Price pass: {len(candidates)} vendor listing(s) to check.")
    throttle = HostThrottle()
    page = context.new_page()
    try:
        for vk in candidates:
            if now_ms() > deadline:
                log("Price pass: time budget reached — stopping.")
                break
            stats["attempted"] += 1
            # Defensive: a blank productUrl (bad import data) would send the
            # browser to "" and fail the whole row loudly — the SQL filter
            # excludes them, but guard here too and rotate the row onward.
            product_url = (vk["productUrl"] or "").strip()
            if not product_url:
                log(f"  blank productUrl — skipped (VendorKit {vk['id']})")
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET "productUrl" = NULL, '
                        '"priceUpdatedAt" = now() WHERE id = %s',
                        (vk["id"],),
                    )
                conn.commit()
                stats["failed"] += 1
                continue
            # Shopify exposes /products/<handle>.json; everything else (Latamkeys
            # /productos/, STACKS /store/) is a generic WooCommerce storefront.
            price_fn = (
                shopify_price if "/products/" in product_url else generic_price
            )
            stats["throttled_s"] += throttle.wait(product_url)
            # A set that IS a subkit (dcs.wiki catalogs "…40s kit", "10U
            # Spacebars", "Bae Addon" as products) must not have its own kind of
            # variant excluded — on those listings the 40s/spacebar variant is
            # the base kit. Without this, Saber Keebs' After School page priced
            # at $10 (a BAE add-on) instead of $140, because the $140 variant is
            # titled "40s Monokit".
            allow_subkits = bool(
                _SUBKIT_PRODUCT_RE.search(vk.get("set_name") or "")
            )
            result = price_fn(
                page,
                product_url,
                vk.get("vendor_currency"),
                scrapling,
                allow_subkits,
            )
            outcome = (
                "GONE" if result == DEAD_LINK
                else "NO_BASE_KIT" if result == NO_BASE_KIT
                else "PRICE_REFUSED" if result == PRICE_REFUSED
                else "NO_PRODUCT_DATA" if result == NO_PRODUCT_DATA
                else "PRICED" if result
                else "UNREADABLE"
            )
            failures, dead_since = next_link_health(
                vk.get("linkFailures"), vk.get("deadSince"), outcome
            )
            if result == DEAD_LINK:
                # The store answered "gone". Clear the price like NO_BASE_KIT
                # does — a removed listing must not keep quoting its last price
                # — but leave priceSource alone: this page was never READ, and
                # stamping it 'SCRAPED' is what made a closed store read as a
                # pricing backlog for months.
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET price = NULL, "compareAtPrice" = NULL, '
                        '"inStock" = false, variants = \'[]\'::jsonb, '
                        '"priceUpdatedAt" = now(), "linkFailures" = %s, '
                        '"deadSince" = %s WHERE id = %s',
                        (failures, dead_since, vk["id"]),
                    )
                conn.commit()
                stats["dead"] += 1
                stats["failed"] += 1
            elif result in (PRICE_REFUSED, NO_PRODUCT_DATA):
                # The page was fetched. Record WHAT was learned — priceSource is
                # the only column that carries it, and leaving it NULL is what
                # made a live store read as a dead link set — but do NOT touch
                # the price: the refusal is about the number just read, and a
                # page with no markup says nothing about the last good one.
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET "priceUpdatedAt" = now(), '
                        '"priceSource" = %s, "linkFailures" = %s, '
                        '"deadSince" = %s WHERE id = %s',
                        (
                            PRICE_SOURCE_REFUSED
                            if result == PRICE_REFUSED
                            else PRICE_SOURCE_UNPARSED,
                            failures,
                            dead_since,
                            vk["id"],
                        ),
                    )
                conn.commit()
                if result == PRICE_REFUSED:
                    stats["refused"] += 1
                else:
                    stats["unparsed"] += 1
            elif result == NO_BASE_KIT:
                # Listing has no base kit (only subkits) — clear any stale price
                # so the wrong subkit number stops showing, instead of letting
                # it persist run after run. Counts as a successful update.
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET price = NULL, "compareAtPrice" = NULL, '
                        '"inStock" = false, '
                        'variants = \'[]\'::jsonb, "priceUpdatedAt" = now(), '
                        '"priceSource" = \'SCRAPED\', "linkFailures" = %s, '
                        '"deadSince" = %s WHERE id = %s',
                        (failures, dead_since, vk["id"]),
                    )
                conn.commit()
                stats["updated"] += 1
            elif result:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET price = %s, currency = %s, '
                        '"compareAtPrice" = %s, '
                        'variants = %s::jsonb, "inStock" = %s, '
                        '"priceUpdatedAt" = now(), "priceSource" = \'SCRAPED\', '
                        '"linkFailures" = %s, "deadSince" = %s WHERE id = %s',
                        (
                            result["price"],
                            result["currency"],
                            result.get("compareAt"),
                            json.dumps(result["variants"]),
                            result["inStock"],
                            failures,
                            dead_since,
                            vk["id"],
                        ),
                    )
                conn.commit()
                stats["updated"] += 1
            else:
                # Record the attempt so the oldest-first queue rotates onward,
                # and count it: enough consecutive unreadable answers is the
                # only evidence a store that redirects, 401s, 402s or stopped
                # resolving ever gives.
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET "priceUpdatedAt" = now(), '
                        '"linkFailures" = %s, "deadSince" = %s WHERE id = %s',
                        (failures, dead_since, vk["id"]),
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

# A keycap-defining noun ANYWHERE in the title (not just a leading profile) also
# marks a keycap product — e.g. "Awekeys Viking Antiques Full Metal Keycaps",
# "Mtbkeys Metal Spacebars". Guarded by the absence of a definitive keyboard
# word so a real board ("… Electrostatic keyboard …") is never mis-dropped.
_KB_KEYCAP_NOUN_RE = re.compile(r"\b(?:keycaps?|keysets?|spacebars?|novelties)\b", re.I)
_KB_KEYBOARD_WORD_RE = re.compile(
    r"\b(?:keyboard|pcb|barebones|hotswap|gasket|switches?)\b", re.I
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
    # UniKeys (unikeyboards.com) — Canadian store, prices in USD. The keyboard
    # classifier keeps the boards and drops the keycap/switch/accessory catalogue.
    ("uni", "UniKeys", [
        "https://unikeyboards.com/collections/ongoing-groupbuys-and-pre-orders/products.json",
        "https://unikeyboards.com/collections/group-buy/products.json",
    ], "USD", "CA"),
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
    title = product.get("title", "")
    if _KB_KEYCAP_PROFILE_RE.search(title):
        return True
    # Keycap noun anywhere (Full Metal Keycaps, Metal Spacebars), as long as the
    # title doesn't also name a board component.
    if _KB_KEYCAP_NOUN_RE.search(title) and not _KB_KEYBOARD_WORD_RE.search(title):
        return True
    return False


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
    trust_level, trust_reason = _gh_data_trust(status, existing_end, last_post_dt)
    topic_url = f"https://geekhack.org/index.php?topic={topic_id}.0"
    with conn.cursor() as cur:
        if product_type == "UNKNOWN":
            cur.execute(
                """
                UPDATE "GroupBuy"
                SET status = %s::"GBStatus",
                    "sourceType" = 'GEEKHACK',
                    "sourceUrl" = COALESCE("sourceUrl", %s),
                    "sourceLastCheckedAt" = now(),
                    "sourceLastActivityAt" = COALESCE(%s, "sourceLastActivityAt"),
                    "dataTrustLevel" = %s,
                    "dataTrustReason" = %s,
                    "updatedAt" = now()
                WHERE slug = %s
                """,
                (
                    status,
                    topic_url,
                    last_post_dt,
                    trust_level,
                    trust_reason,
                    f"gh-{topic_id}",
                ),
            )
        else:
            cur.execute(
                """
                UPDATE "GroupBuy"
                SET status = %s::"GBStatus",
                    "productType" = %s,
                    "sourceType" = 'GEEKHACK',
                    "sourceUrl" = COALESCE("sourceUrl", %s),
                    "sourceLastCheckedAt" = now(),
                    "sourceLastActivityAt" = COALESCE(%s, "sourceLastActivityAt"),
                    "dataTrustLevel" = %s,
                    "dataTrustReason" = %s,
                    "updatedAt" = now()
                WHERE slug = %s
                """,
                (
                    status,
                    product_type,
                    topic_url,
                    last_post_dt,
                    trust_level,
                    trust_reason,
                    f"gh-{topic_id}",
                ),
            )


def _gh_data_trust(status: str, gb_end_date, last_post_dt: datetime | None) -> tuple[str, str | None]:
    """Classify Geekhack source confidence separately from GB lifecycle status."""
    now = datetime.now(timezone.utc)
    days_since_activity = (now - last_post_dt).days if last_post_dt else None

    if gb_end_date:
        return "TRUSTED", None

    if status in ("ACTIVE_GB", "INTEREST_CHECK"):
        if days_since_activity is not None and days_since_activity > 120:
            return (
                "DEAD",
                "Geekhack thread appears inactive and has no confirmed group-buy end date.",
            )
        if days_since_activity is None or days_since_activity > 45:
            return (
                "STALE",
                "Geekhack thread has no confirmed GB end date and has not shown recent source activity.",
            )
        return "CAUTION", "Geekhack source is missing a confirmed group-buy end date."

    if days_since_activity is None or days_since_activity > 365:
        return (
            "STALE",
            "Geekhack lifecycle status is inferred from an inactive source with no confirmed GB end date.",
        )

    return "CAUTION", "Geekhack source is missing a confirmed group-buy end date."


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


def ensure_base_kit(conn, gb_id: str) -> None:
    """Guarantee a set has a BASE Kit row.

    Vendor linking is only possible through a BASE kit: _build_set_index INNER
    JOINs on it, and every pass that attaches a VendorKit (discovery, outlets,
    gmk_direct) writes against base_kit_id. Historically only the gmk.net and
    KBDfans upserts created one, so a set whose ONLY source is Geekhack had no
    kit and could therefore never receive a price — which is exactly the state
    every DCS set was in (14 of 15 live DCS rows had no kit at all).
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "Kit" (id, name, type, "groupBuyId")
            SELECT gen_random_uuid()::text, 'Base Kit', 'BASE', %s
            WHERE NOT EXISTS (
                SELECT 1 FROM "Kit" WHERE "groupBuyId" = %s AND type = 'BASE'
            )
            """,
            (gb_id, gb_id),
        )


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
    source_type = data.get("source_type") or "GEEKHACK"
    source_last_activity_at = data.get("source_last_activity_at")
    data_trust_level = data.get("data_trust_level") or "TRUSTED"
    data_trust_reason = data.get("data_trust_reason")

    # Try to match existing row
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            'SELECT id, slug, "productUrl", "sourceType", description FROM "GroupBuy" WHERE slug = ANY(%s)',
            (variants,),
        )
        existing = cur.fetchone()

    if existing:
        # Enrich conservatively: only fill blank image fields; never overwrite
        # productUrl (that's the vendor buy-link). Re-running a previously empty
        # thread can therefore repair its card without replacing curated data.
        is_forum_record = (
            str(existing["slug"]).startswith("gh-")
            or "geekhack.org/index.php?topic=" in (existing.get("productUrl") or "")
            or existing.get("sourceType") == "GEEKHACK"
        )
        with conn.cursor() as cur:
            if is_forum_record:
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
                        "sourceType" = %s,
                        "sourceUrl" = COALESCE("sourceUrl", %s),
                        "sourceLastCheckedAt" = now(),
                        "sourceLastActivityAt" = COALESCE(%s, "sourceLastActivityAt"),
                        "dataTrustLevel" = %s,
                        "dataTrustReason" = %s,
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
                        source_type,
                        topic_url,
                        source_last_activity_at,
                        data_trust_level,
                        data_trust_reason,
                        existing["slug"],
                    ),
                )
            else:
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
        # A Geekhack-only keycap set needs a BASE kit or it can never be priced.
        if product_type == "KEYCAPS":
            ensure_base_kit(conn, existing["id"])
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
                 "productUrl", "gbEnd",
                 "sourceType", "sourceUrl", "sourceLastCheckedAt",
                 "sourceLastActivityAt", "dataTrustLevel", "dataTrustReason",
                 "createdAt", "updatedAt")
            VALUES
                (gen_random_uuid()::text, %s, %s, '', %s, %s::"GBStatus", %s,
                 %s, %s, now(), %s, false,
                 %s, %s,
                 %s, %s, now(), %s, %s, %s,
                 now(), now())
            ON CONFLICT (slug) DO NOTHING
            RETURNING id
            """,
            (
                insert_slug, title, designer, status, product_type,
                image_url, images, description,
                topic_url, gb_end_ts,
                source_type, topic_url, source_last_activity_at,
                data_trust_level, data_trust_reason,
            ),
        )
        row = cur.fetchone()
    new_id = row["id"] if row else None
    # Same for a freshly-created row: without a BASE kit no vendor listing can
    # ever attach, so the set would stay permanently priceless.
    if new_id and product_type == "KEYCAPS":
        ensure_base_kit(conn, new_id)
    return new_id, True


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
                trust_level, trust_reason = _gh_data_trust(status, gb_end_date, last_post_dt)

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
                    "source_type": "GEEKHACK",
                    "source_last_activity_at": last_post_dt,
                    "data_trust_level": trust_level,
                    "data_trust_reason": trust_reason,
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
        "--dcs-only",
        action="store_true",
        help=(
            "Run only the dcs.wiki catalog pass (import the DCS keycap archive "
            "and its live group-buy/interest-check statuses)."
        ),
    )
    parser.add_argument(
        "--discovery-only",
        action="store_true",
        help=(
            "Run only the vendor-catalog discovery pass (crawl vendor Shopify "
            "catalogs for GMK listings and link them to tracked sets)."
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
                elif args.discovery_only:
                    log(
                        f"Vendor-catalog discovery only; "
                        f"budget={budget_minutes} minutes."
                    )
                    disc_stats = run_discovery(conn, context, deadline, scrapling)
                elif args.dcs_only:
                    log(
                        f"dcs.wiki catalog only; budget={budget_minutes} minutes."
                    )
                    dcs_stats = run_dcs_catalog(conn, context, deadline, scrapling)
                else:
                    # Catalog first so image + price passes have full set coverage
                    catalog_stats = run_catalog(conn, context, deadline, scrapling)
                    # dcs.wiki is the DCS profile's gmk.net — same role, so it
                    # runs alongside the GMK catalog and ahead of everything
                    # that needs complete set coverage.
                    dcs_stats = run_dcs_catalog(conn, context, deadline, scrapling)
                    zf_stats = run_zfrontier(conn, context, deadline)
                    kbdgb_stats = run_kbdfans_gb(conn, context, deadline, scrapling)
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
                    # Discovery before pricing so freshly-linked vendor listings
                    # get a price on the same nightly run. Dead links found by
                    # the price pass clear themselves (404/410 → price cleared).
                    disc_stats = run_discovery(conn, context, deadline, scrapling)
                    # Outlets AFTER discovery (outlet links win the night) and
                    # BEFORE prices (discounted listings priced tonight).
                    out_stats = run_outlets(conn, context, deadline, scrapling)
                    # GMK's own Warehouse Finds sale — prices itself (Shopware,
                    # outside the Shopify price pass).
                    gd_stats = run_gmk_direct(conn, context, deadline, scrapling)
                    price_stats = run_prices(conn, context, deadline, scrapling)
            finally:
                context.close()
                if temporary_profile is not None:
                    shutil.rmtree(temporary_profile, ignore_errors=True)

        if scrapling.available:
            log(f"Scrapling acquisition -> {scrapling.stats.summary()}")
            # Totals alone can't tell you whether one store is rate-limiting us
            # or the whole network path is down. Name the worst offenders.
            problems = scrapling.stats.problem_summary()
            if problems:
                log(f"  worst hosts -> {problems}")

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

    if args.dcs_only:
        log(f"DCS catalog -> sets={dcs_stats['urls_found']} "
            f"created={dcs_stats['created']} updated={dcs_stats['updated']} "
            f"skipped={dcs_stats['skipped']} failed={dcs_stats['failed']} "
            f"ics={dcs_stats['interest_checks']}")
        log("DCS catalog done. Re-run safely if the deadline was reached.")
        return 0

    if args.discovery_only:
        log(f"Discovery -> vendors={disc_stats['vendors']} "
            f"gmk_listings={disc_stats['gmk_listings']} linked={disc_stats['linked']} "
            f"relinked={disc_stats['relinked']} "
            f"multi_listing={disc_stats['multi_listing']}")
        log("Discovery done. Re-run safely to crawl the next batch of vendors.")
        return 0

    log(f"Catalog -> urls={catalog_stats['urls_found']} "
        f"created={catalog_stats['created']} updated={catalog_stats['updated']} "
        f"skipped={catalog_stats['skipped']} failed={catalog_stats['failed']}")
    log(f"DCS catalog -> sets={dcs_stats['urls_found']} "
        f"created={dcs_stats['created']} updated={dcs_stats['updated']} "
        f"skipped={dcs_stats['skipped']} failed={dcs_stats['failed']} "
        f"ics={dcs_stats['interest_checks']}")
    log(f"zFrontier -> cards={zf_stats['cards']} created={zf_stats['created']} "
        f"updated={zf_stats['updated']} skipped={zf_stats['skipped']} "
        f"failed={zf_stats['failed']}")
    log(f"KBDfans GB -> products={kbdgb_stats['products']} created={kbdgb_stats['created']} "
        f"updated={kbdgb_stats['updated']} skipped={kbdgb_stats['skipped']} "
        f"failed={kbdgb_stats['failed']}")
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
    log(f"Discovery -> vendors={disc_stats['vendors']} "
        f"gmk_listings={disc_stats['gmk_listings']} linked={disc_stats['linked']} "
        f"relinked={disc_stats['relinked']} "
        f"multi_listing={disc_stats['multi_listing']}")
    log(f"Outlets -> collections={out_stats['collections']} "
        f"products={out_stats['products']} linked={out_stats['linked']} "
        f"skipped_hosts={out_stats['skipped_hosts']}")
    log(f"GMK Direct -> pages={gd_stats['pages']} priced={gd_stats['priced']} "
        f"out_of_stock={gd_stats['out_of_stock']} unmatched={gd_stats['unmatched']}")
    log(f"Prices  -> throttle_wait={price_stats['throttled_s']:.0f}s")
    # `dead` is a subset of `failed`: the store answered 404/410. Split out so a
    # run whose failures are all dead links doesn't read as a blocked run.
    # `refused` and `unparsed` are neither failures nor updates — the store
    # answered and the row stays unpriced because this side refused the number
    # or could not read the page's platform, neither of which another run fixes.
    log(f"Prices  -> attempted={price_stats['attempted']} "
        f"updated={price_stats['updated']} failed={price_stats['failed']} "
        f"dead={price_stats['dead']} refused={price_stats['refused']} "
        f"unparsed={price_stats['unparsed']}")
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
