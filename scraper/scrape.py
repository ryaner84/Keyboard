"""
GMK price-locator scraper — runs on the Windows AWS WorkSpace.

Why this exists: Vercel's server-side fetch() is blocked (HTTP 403) by bot
protection on gmk.net (per-kit render images) and on Cloudflare-fronted vendor
Shopify stores (prices). A REAL headful Chromium on the WorkSpace presents a
genuine TLS/JS fingerprint and a persistent cf_clearance cookie, so it succeeds
where the serverless scraper fails.

It writes directly into the SAME Supabase Postgres DB the Vercel site reads,
so updates appear live with no deploy:
  - GroupBuy.images[]  (+ imageUrl = images[0])   from gmk.net galleries
  - VendorKit.price/currency/priceUpdatedAt/priceSource='SCRAPED'  from vendors

It NEVER overwrites a price whose priceSource = 'MANUAL'.

Run via scraper/run-scraper.bat (which git-pulls the latest copy first).
"""

from __future__ import annotations

import configparser
import csv
import getpass
import os
import re
import sys
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


def build_conn_string(cfg: dict, password: str) -> str:
    pw = urllib.parse.quote(password, safe="")
    return (
        f"postgresql://postgres.{cfg['ref']}:{pw}@{cfg['host']}:5432/postgres"
        f"?sslmode=require"
    )


def try_connect(conn_string: str):
    """Return a live connection or raise OperationalError on bad auth/unreachable."""
    conn = psycopg2.connect(conn_string, connect_timeout=15)
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


def get_connection(cfg: dict):
    """
    First-run flow: try the saved password; if missing or wrong, prompt the user
    (hidden input), validate against Supabase, loop until it works, then persist.
    """
    saved = read_saved_password()
    if saved:
        try:
            conn = try_connect(build_conn_string(cfg, saved))
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
            conn = try_connect(build_conn_string(cfg, password))
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
# Image extraction — ported verbatim from src/lib/import/gmk-images.ts
# ----------------------------------------------------------------------------
_IMG_RE = re.compile(
    r"""(?:src|data-src|data-zoom-image|content)\s*=\s*["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']""",
    re.IGNORECASE,
)
_DROP_RE = re.compile(r"(logo|icon|sprite|payment|flag|placeholder)", re.IGNORECASE)


def extract_gmk_images(html: str) -> list[str]:
    seen: list[str] = []
    for m in _IMG_RE.finditer(html):
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


def shopify_price(page: Page, product_url: str) -> dict | None:
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
        variants = data["product"].get("variants") or []
        prices = []
        for v in variants:
            try:
                p = float(v.get("price"))
            except (TypeError, ValueError):
                continue
            if p > 0:
                prices.append(p)
        if not prices:
            return None
        price = min(prices)

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
        return {"price": price, "currency": currency or "USD"}
    except Exception as e:  # noqa: BLE001
        log(f"  price fetch failed for {product_url}: {e}")
        return None


# ----------------------------------------------------------------------------
# DB candidate queries (mirror enrich-images.ts and prices.ts)
# ----------------------------------------------------------------------------
def fetch_image_candidates(conn, limit: int = 200) -> list[dict]:
    sql = """
        SELECT gb.id, gb.slug, gb."imageUrl", gb.images,
               (SELECT vk."productUrl"
                  FROM "VendorKit" vk
                  JOIN "Kit" k ON k.id = vk."kitId"
                 WHERE k."groupBuyId" = gb.id
                   AND vk."productUrl" ILIKE '%gmk.net%'
                 LIMIT 1) AS gmk_url
          FROM "GroupBuy" gb
         WHERE COALESCE(cardinality(gb.images), 0) <= 1
           AND EXISTS (
                SELECT 1 FROM "VendorKit" vk
                  JOIN "Kit" k ON k.id = vk."kitId"
                 WHERE k."groupBuyId" = gb.id
                   AND vk."productUrl" ILIKE '%gmk.net%')
         LIMIT %s
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (limit,))
        return cur.fetchall()


def fetch_price_candidates(conn, limit: int = 500) -> list[dict]:
    sql = """
        SELECT id, "productUrl"
          FROM "VendorKit"
         WHERE "productUrl" IS NOT NULL
           AND ("priceSource" IS NULL OR "priceSource" <> 'MANUAL')
         ORDER BY "priceUpdatedAt" ASC NULLS FIRST
         LIMIT %s
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (limit,))
        return cur.fetchall()


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
                stats["failed"] += 1
                continue
            base = gb["images"] or ([gb["imageUrl"]] if gb["imageUrl"] else [])
            merged = dedupe_keep_order(list(base) + gallery)
            if len(merged) > len(base):
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "GroupBuy" SET images = %s, "imageUrl" = %s WHERE id = %s',
                        (merged, merged[0], gb["id"]),
                    )
                conn.commit()
                stats["enriched"] += 1
                log(f"  {gb['slug']}: {len(base)} -> {len(merged)} images")
            else:
                stats["failed"] += 1
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
            result = shopify_price(page, vk["productUrl"])
            if result:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "VendorKit" SET price = %s, currency = %s, '
                        '"priceUpdatedAt" = now(), "priceSource" = \'SCRAPED\' WHERE id = %s',
                        (result["price"], result["currency"], vk["id"]),
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
            img_stats = run_images(conn, context, deadline)
            price_stats = run_prices(conn, context, deadline)
        finally:
            context.close()

    conn.close()
    log(f"Images  -> attempted={img_stats['attempted']} "
        f"enriched={img_stats['enriched']} failed={img_stats['failed']}")
    log(f"Prices  -> attempted={price_stats['attempted']} "
        f"updated={price_stats['updated']} failed={price_stats['failed']}")
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
