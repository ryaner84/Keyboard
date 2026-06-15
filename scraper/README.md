# GMK Scraper — Windows WorkSpace setup

This scraper runs on your **Windows AWS WorkSpace** (the virtual desktop you reach
over Remote Desktop). It uses a **real Chromium browser** to read data that Vercel
can't fetch because of bot protection:

- **gmk.net** → per‑kit render images (the set image carousel)
- **vendor Shopify stores** → live keycap prices
- **zFrontier** → active GMK group buys in the Asia community
- **keyboard vendor stores** → keyboard group buys (NovelKeys, CannonKeys,
  KBDfans, MatrixLab, Prototypist, KLC, Ktechs, Pantheon, ClickClack, iLumKB)

It writes straight into the **same Supabase database** the website reads, so updates
appear on the live site with no deploy. The website reads pages dynamically, so a
scraped price/image shows on the next page load.

It never overwrites a price you set manually in the admin panel
(`priceSource = 'MANUAL'`), nor a keyboard's admin‑set layout / mount / material.

> **Keyboards run here, not on Vercel.** The Vercel `/api/cron/keyboards` job
> returned 0 because serverless IPs are blocked by the stores and the build
> couldn't migrate the database. Keyboards change infrequently, so the nightly
> browser run on the WorkSpace covers them reliably. That cron is now unscheduled.

---

## What runs

- `scrape.py` — the scraper (Playwright + direct Postgres writes). Runs five
  passes each night: **GMK catalog** → **zFrontier** → **keyboards** →
  **images** → **prices**, sharing a 30‑minute time budget.
- `schedule_time.py` — prints the PC‑local time equal to **00:00 GMT+8**.
- `run-scraper.bat` — **the file you double‑click.** Each run it: `git pull`s the
  latest `scrape.py`, ensures Python + Playwright are installed, asks for the DB
  password the first time, registers the nightly schedule, then runs.
- `config.ini` — your Supabase project ref + region (not secret).
- `credentials.csv` — created on first run, holds your DB password. **Gitignored —
  never committed.**

---

## One‑time setup (do this once over RDP)

1. **Install Git for Windows** if it isn't already:
   `winget install Git.Git`
   (Python is installed automatically by the `.bat` if missing.)

2. **Clone the repo** somewhere on the WorkSpace, e.g.:
   ```
   git clone https://github.com/ryaner84/keyboard.git C:\GMK\Keyboard
   ```
   When prompted, sign in with your GitHub username + a **Personal Access Token**
   (Settings → Developer settings → Tokens). Git remembers it via Credential
   Manager, so the nightly `git pull` works unattended.

3. **Fill in `scraper\config.ini`** with your Supabase **project ref** and **region**
   (Supabase → Project Settings → Database → Connection string). Leave `host` blank
   unless your pooler host is non‑standard.

4. **Double‑click `scraper\run-scraper.bat`.** On this first run it will:
   - install Python deps + Chromium,
   - **ask for your Supabase database password** (typed hidden). It tests the
     password against the database and keeps asking until it's correct, then saves
     it to `credentials.csv` so future runs are silent.
   - register a Task Scheduler job **"GMK Scraper"** that runs daily at the local
     time equal to **00:00 GMT+8**,
   - open a visible Chromium window and start scraping. **If gmk.net or Cloudflare
     shows a "verify you're human" challenge, solve it once in that window.** The
     browser profile (`.scraper-profile`) remembers the clearance so later runs
     pass automatically.

That's the "initial one‑time run." After this, it runs itself nightly.

---

## Keeping the nightly run alive

- The scrape uses a **visible** browser, which needs an interactive desktop session.
- On AWS WorkSpaces, **disconnect** your RDP session (close the window) instead of
  **signing out**. Disconnecting keeps the session — and the scheduled run — alive.
  Signing out ends the session and the nightly job won't run.

---

## Changing what gets scraped

Just edit `scraper/scrape.py` in GitHub (or locally and push). The nightly
`run-scraper.bat` does `git pull` before every run, so the next run uses your
latest code — nothing to re‑install on the WorkSpace.

**To add a keyboard vendor**, append a tuple to `KEYBOARD_VENDORS` in
`scrape.py`:

```python
("id", "Display Name",
 ["https://store.com/collections/group-buy/products.json"],  # one or more
 "USD", "US"),   # currency, region
```

The collection's URL slug sets the default stage (`group-buy`/`ongoing-gb` →
Active, `extra-drop`/`extras` → Extra Drop, `pre-order`/`coming-soon` →
Pre‑order). Anything under **$300** or any **Keychron** product is dropped.

---

## Checking it worked

- Console output and `scraper\logs\scrape_<date>.log` show counts like
  `Images -> attempted=… enriched=…`, `Prices -> attempted=… updated=…`, and
  `Keyboards -> fetched=… created=… updated=… failed=…`.
- In Supabase SQL editor:
  ```sql
  select slug, array_length(images,1) from "GroupBuy" where slug='gmk-masterpiece-r2';
  select "productUrl","price","priceSource","priceUpdatedAt"
    from "VendorKit" where "priceSource"='SCRAPED'
    order by "priceUpdatedAt" desc limit 10;
  -- keyboards scraped this run:
  select slug,"vendorName",status,"basePrice","priceCurrency"
    from "GroupBuy" where "productType"='KEYBOARD'
    order by "updatedAt" desc limit 20;
  ```
- On the live site, open a scraped set: the carousel shows multiple renders and
  vendor rows show real prices. The **`/keyboards`** dashboard lists the scraped
  boards with price + stage.

---

## Troubleshooting

- **It asks for the password again** → the saved one was rejected (e.g. you rotated
  the Supabase password). Just enter the new one; it re‑saves.
- **Prices/images stay empty for a store** → that store showed a challenge the
  browser couldn't pass unattended. Run the `.bat` manually once and solve it; the
  profile will remember it.
- **Scheduled run didn't fire** → make sure you **disconnected** rather than signed
  out, and that the WorkSpace was left running. Check Task Scheduler → "GMK Scraper".
- **Wrong time** → the schedule auto‑recomputes 00:00 GMT+8 in local time on every
  run, so it self‑corrects after the first nightly execution.
