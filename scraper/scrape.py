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

import configparser
import csv
import getpass
import json
import os
import random
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path

import psycopg2
from psycopg2 import OperationalError
from psycopg2.extras import RealDictCursor
from playwright.sync_api import sync_playwright, Page, BrowserContext

# ----------------------------------------------------------------------------
# Paths & config
# ----------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.ini"
LOCAL_CONFIG_PATH = HERE / "config.local.ini"
CREDENTIALS_PATH = HERE / "credentials.csv"
PROFILE_DIR = HERE / ".scraper-profile"
LOG_DIR = HERE / "logs"
GH_SEEN_PATH = HERE / "gh_seen.json"  # topic_id → last_post_at ISO — never committed

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
def gmk_gallery(page: Page, url: str) -> list[str]:
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        # Give the gallery a chance to render; tolerate timeout.
        try:
            page.wait_for_selector('img[src*="/media/"]', timeout=8_000)
        except Exception:  # noqa: BLE001
            pass
        return extract_gmk_images(page.content())
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
    Preference: BASE-classified variant > first non-add-on variant (Shopify
    returns variants in display order; single-kit listings have one 'Default
    Title' variant)."""
    if not variants:
        return None
    non_addon = [v for v in variants if not _ADDON_VARIANT_RE.search(v["title"])]
    pool = non_addon if non_addon else variants
    for v in pool:
        if classify_variant(v["title"]) == "BASE":
            return v
    return pool[0]


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


def shopify_price(page: Page, product_url: str, vendor_currency: str | None) -> dict | None:
    """Navigate to the product (acquires cf_clearance) then fetch its .json from
    inside the page context so the request carries the clearance cookies."""
    if "/products/" not in product_url:
        return None
    pinned_id = pinned_variant_id(product_url)
    clean = product_url.split("?")[0].split("#")[0].rstrip("/")
    json_url = clean + ".json"
    origin = urllib.parse.urlsplit(clean)
    origin_url = f"{origin.scheme}://{origin.netloc}"
    try:
        page.goto(product_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        data = page.evaluate(
            """async (u) => {
                try {
                    const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
                    if (!r.ok) return null;
                    return await r.json();
                } catch (e) { return null; }
            }""",
            json_url,
        )
        if not data or "product" not in data:
            return None

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

        # Step 1: try the Shopify /meta.json endpoint (most reliable — this is
        # the store's PRIMARY currency that prices are denominated in).
        currency = page.evaluate(
            """async (o) => {
                try {
                    const r = await fetch(o + '/meta.json', { headers: { 'Accept': 'application/json' } });
                    if (!r.ok) return null;
                    const m = await r.json();
                    return m.currency || null;
                } catch (e) { return null; }
            }""",
            origin_url,
        )

        # Step 2: fall back to reading the currency FROM THE PAGE if meta.json
        # failed or returned nothing. Shopify stores expose the active currency
        # in several places we can read without JS-heavy interaction:
        #   a) The cart API (/cart.js) includes a currency field.
        #   b) Many themes render a visible currency selector whose selected
        #      option has a 3-letter currency code.
        #   c) The Shopify global variable window.Shopify.currency.active.
        # We try all three in order and take the first ISO-4217 match.
        if not currency:
            currency = page.evaluate(
                """async (o) => {
                    // a) Cart API — most Shopify stores allow this unauthenticated
                    try {
                        const r = await fetch(o + '/cart.js', { headers: { 'Accept': 'application/json' } });
                        if (r.ok) {
                            const c = await r.json();
                            if (c && c.currency && /^[A-Z]{3}$/.test(c.currency)) return c.currency;
                        }
                    } catch (e) {}
                    // b) window.Shopify.currency — injected by Shopify themes
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
                }""",
                origin_url,
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
                page.context.add_cookies([
                    {"name": "cart_currency", "value": currency, "url": origin_url},
                    {"name": "localization",
                     "value": _CURRENCY_HOME_COUNTRY[currency], "url": origin_url},
                ])
                repin = page.evaluate(
                    """async (u) => {
                        try {
                            const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
                            if (!r.ok) return null;
                            return await r.json();
                        } catch (e) { return null; }
                    }""",
                    json_url,
                )
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

        # Stored variants carry title+price only (what the UI parses).
        variants = [{"title": v["title"], "price": v["price"]} for v in variants]
        return {"price": chosen["price"], "currency": currency, "variants": variants}
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
# e.g. https://www.gmk.net/shop/en/gmk-cyl-ramune/gmk10108
# The slug matches our DB slug format exactly.
# ----------------------------------------------------------------------------

GMK_NET_ORIGIN = "https://www.gmk.net"
GMK_NET_CATALOG_URLS = [
    "https://www.gmk.net/shop/en/keycaps/",
    "https://www.gmk.net/shop/en/group-buys/",
]
GMK_VENDOR_SLUG = "gmk"

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
        # Find the slug: it follows 'en' and precedes the product-id (gmkXXXXX)
        for i, part in enumerate(parts):
            if part == "en" and i + 1 < len(parts):
                candidate = parts[i + 1]
                # The product id (gmk10108 pattern) is the NEXT segment
                if re.match(r"^gmk[\d]+$", candidate, re.IGNORECASE):
                    # The URL only has the product id after /en/ — unusual, skip
                    continue
                return candidate
    except Exception:
        pass
    return None


def scrape_catalog_page_urls(page: Page, catalog_url: str) -> list[str]:
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

        try:
            page.goto(current, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            try:
                page.wait_for_selector("a[href]", timeout=8_000)
            except Exception:
                pass
        except Exception as e:
            log(f"  Catalog page {page_num} ({current}): {e}")
            break

        # Extract all same-origin links that look like product URLs
        links = page.evaluate(f"""() => {{
            const origin = '{GMK_NET_ORIGIN}';
            const links = new Set();
            for (const a of document.querySelectorAll('a[href]')) {{
                const href = a.href;
                if (href.startsWith(origin + '/shop/en/') && !href.includes('?') && !href.includes('#')) {{
                    links.add(href.replace(/\\/$/, ''));
                }}
            }}
            return [...links];
        }}""")

        for link in links:
            clean = str(link).rstrip("/")
            # Product URLs have a slug + product-id segment: /shop/en/{slug}/{gmkXXXXX}
            # Category pages don't have the product-id segment.
            parts = clean.rstrip("/").split("/")
            # Must have at least /shop/en/{slug}/{product-id}
            if len(parts) >= 6 and re.match(r"gmk\d+$", parts[-1], re.IGNORECASE):
                if clean not in product_urls:
                    product_urls.append(clean)

        # Next page (Shopware pagination)
        next_url = page.evaluate("""() => {
            const candidates = [
                document.querySelector('a[rel="next"]'),
                document.querySelector('[aria-label="Next page"]'),
                document.querySelector('.pagination-nav-next a'),
                document.querySelector('.page-item.next a'),
                document.querySelector('link[rel="next"]'),
            ];
            for (const el of candidates) {
                if (el && el.href) return el.href;
            }
            return null;
        }""")

        if not next_url or str(next_url).split("?")[0].rstrip("/") in visited:
            break
        current = str(next_url)

    return product_urls


def scrape_gmk_product_metadata(page: Page, url: str) -> dict | None:
    """Scrape a single GMK.net product page and return set metadata."""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        try:
            page.wait_for_selector("h1", timeout=5_000)
        except Exception:
            pass

        content = page.content()

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


def run_catalog(conn, context: BrowserContext, deadline: float) -> dict:
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
            urls = scrape_catalog_page_urls(catalog_page, cat_url)
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

            metadata = scrape_gmk_product_metadata(detail_page, url)
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
def run_images(conn, context: BrowserContext, deadline: float) -> dict:
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
            gallery = gmk_gallery(page, gmk_url)
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


def run_prices(conn, context: BrowserContext, deadline: float) -> dict:
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
            result = shopify_price(page, vk["productUrl"], vk.get("vendor_currency"))
            if result:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET price = %s, currency = %s, '
                        'variants = %s::jsonb, "inStock" = true, '
                        '"priceUpdatedAt" = now(), "priceSource" = \'SCRAPED\' WHERE id = %s',
                        (
                            result["price"],
                            result["currency"],
                            json.dumps(result["variants"]),
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
KEYBOARD_BLOCKED_BRANDS = ("keychron", "nicepbt")

# Keycap profile prefixes in a product title → it's a keycap set, not a keyboard
_KB_KEYCAP_PROFILE_RE = re.compile(
    r"^\s*(?:gmk|sa\b|dcs\b|mtnu|kat\b|mt3\b|cyl\b|xda\b|mda\b|dsa\b|dss\b|kam\b|"
    r"nicepbt|infinikey|keyreative|melgeek|sp[-\s]?sa)",
    re.I,
)

# Geekhack meta-threads to ignore (announcements, indexes, sticky posts)
_GH_META_RE = re.compile(
    r"^\*{2,}|list\s+of\s+(?:current|running|active)|"
    r"\[index\]|\[master\s+list\]|(?:board|forum)\s+rules",
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


def fetch_collection_products(page: Page, products_json_url: str,
                              deadline: float) -> list[dict]:
    """Navigate to the collection page (acquires cf_clearance) then fetch its
    paginated products.json from the page context so it carries the cookies."""
    collection_page = products_json_url.replace("/products.json", "")
    try:
        page.goto(collection_page, wait_until="domcontentloaded",
                  timeout=NAV_TIMEOUT_MS)
    except Exception as e:
        log(f"  collection nav failed ({collection_page}): {e}")

    products: list[dict] = []
    pg = 1
    while pg <= 10:
        if now_ms() > deadline:
            break
        url = f"{products_json_url}?limit=250&page={pg}"
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


def run_keyboards(conn, context: BrowserContext, deadline: float) -> dict:
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
                for p in fetch_collection_products(page, url, deadline):
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
# Geekhack board 70.0 scraper
# Reads the Group Buy listing, opens each thread that has a new last-post,
# extracts the first post (OP), and upserts into GroupBuy.
# Re-scrape guard: gh_seen.json tracks the last-post datetime we processed
# per topic so unchanged threads are skipped without opening them.
# ----------------------------------------------------------------------------

# Keycap profile keywords in thread titles → productType = "KEYCAPS"
_GH_KEYCAP_PROFILE = re.compile(
    r"\b(GMK|SA|DCS|MTNU|KAT|MT3|CYL|XDA|MDA|DSA|DSS|KAM|OG|SP[-\s]?SA|"
    r"Signature\s+Plastics|Cherry|PBT|NICEPBT|Infinikey|Keyreative|Melgeek)\b",
    re.I,
)

# Positive keyboard indicators — only these phrases flip the default to KEYBOARD
# (absent these, Geekhack threads default to KEYCAPS since most GBs are keycap sets)
_GH_KB_INDICATOR = re.compile(
    r"\b(keyboard|kbd\b|PCB|build\s+kit|typing\s+kit|FR4\s+plate|"
    r"TGR|Keycult|Norbaforce|Norbauer|Bakeneko|Meletrix|Geonworks|"
    r"Matrix\s*Lab|Rama\s+Works|Duck\s+(?:Orion|Octagon|Viper|Eagle)|"
    r"Hiney|Angry\s+Miao|Percent\s+Studio|Swagkeys)\b",
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


def _gh_detect_product_type(title: str) -> str:
    if _GH_KEYCAP_PROFILE.search(title):
        return "KEYCAPS"
    if _GH_KB_INDICATOR.search(title):
        return "KEYBOARD"
    return "KEYCAPS"  # default: most Geekhack board-70 GBs are keycap sets


def _gh_status(title: str, gb_end_date) -> str:
    """Determine GBStatus from thread title and extracted end date."""
    from datetime import date as _date
    t = title.lower()
    if "[ic]" in t or "interest check" in t:
        return "INTEREST_CHECK"
    if "closed" in t or "fulfilled" in t or "delivered" in t:
        # Could be SHIPPING if recent, DELIVERED if old
        if gb_end_date and isinstance(gb_end_date, _date):
            return "DELIVERED" if gb_end_date < _date.today() else "SHIPPING"
        return "DELIVERED"
    if "shipping" in t or "fulfillment" in t:
        return "SHIPPING"
    if gb_end_date and isinstance(gb_end_date, _date) and gb_end_date < _date.today():
        return "SHIPPING"
    return "ACTIVE_GB"


def _gh_extract_images(html: str) -> list[str]:
    """Pull external image URLs from first-post HTML. Skips forum smileys/avatars."""
    imgs = re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', html, re.I)
    out = []
    for src in imgs:
        lsrc = src.lower()
        # Skip SMF smileys, avatars, icons, tiny images
        if any(x in lsrc for x in ("smiley", "emoji", "avatar", "icon", "thumb", "16x16", "32x32")):
            continue
        # Keep only https:// external images
        if src.startswith("https://"):
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
    const imgs = el ? Array.from(el.querySelectorAll('img')).map(i => i.src) : [];
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
        # Enrich conservatively: only fill blank fields; never overwrite productUrl
        # (that's the vendor buy-link). gbEnd uses COALESCE so we only set if absent.
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "GroupBuy" SET
                    description = CASE WHEN (description IS NULL OR description = '') THEN %s ELSE description END,
                    "gbEnd"     = COALESCE("gbEnd", %s),
                    "updatedAt" = now()
                WHERE slug = %s
                """,
                (description, gb_end_ts, existing["slug"]),
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
                 "imageUrl", images, description, featured,
                 "productUrl", "gbEnd", "createdAt", "updatedAt")
            VALUES
                (gen_random_uuid()::text, %s, %s, '', %s, %s::"GBStatus", %s,
                 %s, %s, %s, false,
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


def run_geekhack(conn, context: BrowserContext, deadline: float) -> dict:
    """
    Scrape geekhack.org board 70.0 (Group Buys).
    - Paginates the listing until all threads with last-post >= GEEKHACK_MIN_YEAR
      are collected (stops at the first page where all visible posts predate the cutoff).
    - For each thread: skip if last-post hasn't advanced since gh_seen.json.
    - Opens thread → reads first post → upserts GroupBuy.
    - Adds random 4–9s jitter between thread opens to be a polite guest.
    """
    stats = {
        "pages": 0, "threads_seen": 0, "skipped_old": 0, "skipped_unchanged": 0,
        "scraped": 0, "created": 0, "updated": 0, "failed": 0,
    }
    log("Geekhack pass: board 70.0 (Group Buys) …")

    seen = _gh_load_seen()
    page = context.new_page()
    try:
        # ── 1. Collect thread listing ──────────────────────────────────────────
        all_threads: list[dict] = []
        start = 0
        while True:
            if now_ms() > deadline:
                log("  Geekhack: deadline reached during listing phase.")
                break
            board_url = (
                f"{GEEKHACK_BOARD_URL};start={start}" if start else GEEKHACK_BOARD_URL
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
                if lp and lp.year >= GEEKHACK_MIN_YEAR:
                    fresh.append(row)
                else:
                    old_count += 1

            all_threads.extend(fresh)
            stats["threads_seen"] += len(rows)
            stats["skipped_old"] += old_count

            # Stop paginating once we hit a page where any thread predates the cutoff
            if old_count > 0:
                break
            start += 20  # SMF paginates in steps of 20

        log(f"  Geekhack: {len(all_threads)} threads from {stats['pages']} pages "
            f"(skipped {stats['skipped_old']} pre-{GEEKHACK_MIN_YEAR})")

        # ── 2. Scrape each thread ──────────────────────────────────────────────
        for thread in all_threads:
            if now_ms() > deadline:
                log("  Geekhack: deadline reached during thread scrape.")
                break

            topic_id = str(thread.get("topic_id") or "")
            if not topic_id:
                continue

            thread_title = thread.get("title") or ""
            if _GH_META_RE.search(thread_title):
                stats["skipped_old"] += 1  # reuse counter; these are noise
                continue

            last_post_dt: datetime | None = thread.get("last_post_dt")
            last_post_iso = last_post_dt.isoformat() if last_post_dt else ""

            # Skip if last-post hasn't advanced
            if seen.get(topic_id) and last_post_iso and last_post_iso <= seen[topic_id]:
                stats["skipped_unchanged"] += 1
                continue

            # Polite delay before opening each thread
            time.sleep(random.uniform(GEEKHACK_DELAY_MIN, GEEKHACK_DELAY_MAX))
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
                images = _gh_extract_images(
                    body_html if body_html else "\n".join(f'<img src="{u}">' for u in raw_images)
                )

                # Re-use the same date extraction logic as the keyboard pass
                gb_end_date = kb_extract_gb_end_date({"body_html": body_html})
                gb_end_ts = (
                    datetime.combine(gb_end_date, datetime.min.time()).replace(tzinfo=timezone.utc)
                    if gb_end_date else None
                )

                product_type = _gh_detect_product_type(title)
                status = _gh_status(title, gb_end_date)

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
        f"old={stats['skipped_old']} unchanged={stats['skipped_unchanged']} "
        f"scraped={stats['scraped']} created={stats['created']} "
        f"updated={stats['updated']} failed={stats['failed']}"
    )
    return stats


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main() -> int:
    global _LOG_FILE
    LOG_DIR.mkdir(exist_ok=True)
    _LOG_FILE = LOG_DIR / f"scrape_{datetime.now(SGT).strftime('%Y-%m-%d')}.log"
    cfg = load_config()

    try:
        conn = get_connection(cfg)
    except OperationalError as e:
        log(f"FATAL: could not connect to the database: {e}")
        return 1

    deadline = now_ms() + SCRAPE_BUDGET_MS
    PROFILE_DIR.mkdir(exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport=None,
            args=["--start-maximized"],
        )
        try:
            # Catalog first so image + price passes have full set coverage
            catalog_stats = run_catalog(conn, context, deadline)
            zf_stats = run_zfrontier(conn, context, deadline)
            kb_stats = run_keyboards(conn, context, deadline)
            gh_stats = run_geekhack(conn, context, deadline)
            img_stats = run_images(conn, context, deadline)
            price_stats = run_prices(conn, context, deadline)
        finally:
            context.close()

    conn.close()
    log(f"Catalog -> urls={catalog_stats['urls_found']} "
        f"created={catalog_stats['created']} updated={catalog_stats['updated']} "
        f"skipped={catalog_stats['skipped']} failed={catalog_stats['failed']}")
    log(f"zFrontier -> cards={zf_stats['cards']} created={zf_stats['created']} "
        f"updated={zf_stats['updated']} skipped={zf_stats['skipped']} "
        f"failed={zf_stats['failed']}")
    log(f"Keyboards -> fetched={kb_stats['fetched']} created={kb_stats['created']} "
        f"updated={kb_stats['updated']} failed={kb_stats['failed']}")
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
