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

It NEVER overwrites a price whose priceSource = 'MANUAL'.

Run via scraper/run-scraper.bat (which git-pulls the latest copy first).
"""

from __future__ import annotations

import configparser
import csv
import getpass
import json
import os
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

# Time budget so a stuck run can't hang the machine forever (no serverless cap).
SCRAPE_BUDGET_MS = 30 * 60 * 1000  # 30 minutes
NAV_TIMEOUT_MS = 30_000

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


def shopify_price(page: Page, product_url: str, vendor_currency: str | None) -> dict | None:
    """Navigate to the product (acquires cf_clearance) then fetch its .json from
    inside the page context so the request carries the clearance cookies."""
    if "/products/" not in product_url:
        return None
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

        raw_variants = data["product"].get("variants") or []
        variants: list[dict] = []
        for v in raw_variants:
            try:
                p = float(v.get("price"))
            except (TypeError, ValueError):
                continue
            if p > 0:
                variants.append({"title": str(v.get("title") or ""), "price": p})

        chosen = choose_kit_variant(variants)
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

        # Step 3: fall back to the vendor's own currency (e.g. DeskHero = CAD),
        # never a blind USD default that inflates CA$88 into US$88.
        currency = currency or vendor_currency

        if not is_plausible_base_price(chosen["price"], currency):
            log(f"  implausible kit price {chosen['price']} {currency} — skipped ({product_url})")
            return None

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
    sql = """
        SELECT vk.id, vk."productUrl", v.currency AS vendor_currency
          FROM "VendorKit" vk
          JOIN "Kit" k ON k.id = vk."kitId"
          JOIN "Vendor" v ON v.id = vk."vendorId"
         WHERE vk."productUrl" IS NOT NULL
           AND k.type = 'BASE'
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

    # Link GMK.net as a vendor for this set (productUrl = the manufacturer page)
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
    log(f"Images  -> attempted={img_stats['attempted']} "
        f"enriched={img_stats['enriched']} failed={img_stats['failed']}")
    log(f"Prices  -> attempted={price_stats['attempted']} "
        f"updated={price_stats['updated']} failed={price_stats['failed']}")
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
