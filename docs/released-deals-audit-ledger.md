# Released deals audit — ledger

Scheduled review of the `/released` **On sale** listings (`/released?deals=1`):
each run takes the next 50 on-sale sets (alphabetical by slug, after the cursor
below), re-reads every priced BASE vendor listing from a GitHub runner with
**Released deals audit** (`released-deals-audit.yml`, `scripts/released-deals-audit.mjs`),
checks link / price / markdown / stock against the store, and files confirmed
problems through the site's own report buttons (the same workflow's `reports`
input → `/api/price-reports` for a vendor row, `/api/listing-reports` for the
listing flag). When the cursor passes the end of the list, the next run wraps
to the start.

## Cursor

`after_slug` for the next run: **`gmk-vamp`**

The list held 53 on-sale sets on 2026-09-26, so the next run covers only what
is left after the cursor (3 sets, unless the list has grown). Once the cursor is
past the end, the following run wraps back to the top of the list.

## Runs

| date | batch (first … last slug) | sets | listings | issues found | reports filed | audit run |
|---|---|---|---|---|---|---|
| 2026-09-26 | dcs-dream-alert … gmk-vamp | 50 | 271 | 12 flagged → 6 confirmed | 6 (price-report button) | [36223373383](https://github.com/ryaner84/Keyboard/actions/runs/36223373383) (reports: [36223666503](https://github.com/ryaner84/Keyboard/actions/runs/36223666503)) |

### 2026-09-26 findings

Run 1 ([36223216800](https://github.com/ryaner84/Keyboard/actions/runs/36223216800))
flagged 113 of 271 listings. Almost all of those were caused by the auditor: a US
runner is served converted USD by Canadian and Australian Shopify Markets stores,
and ex-VAT prices by European ones. After pinning each store's home market the way
`refreshPrices` does, the re-run flagged 12. Each was checked with the
**Vendor probe** ([36223526130](https://github.com/ryaner84/Keyboard/actions/runs/36223526130)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-monarch | Mekibo | USD 200 (was 265), in stock | "[Bundle] Base + Core" 200; **Base Kit 145**, in stock | wrong variant: picker bug, fixed here | price report |
| gmk-teradrive | Mekibo | USD 210 (was 225), in stock | "[Bundle] Base + JIS Mod" 210; **Base Kit 165**, in stock | wrong variant: picker bug, fixed here | price report |
| gmk-panda | iLumKB | SGD 229, in stock | Base 229 **sold out** | stock | price report |
| gmk-hazakura | DeskHero | CAD 246, in stock | "Base Kit" **sold out** (qty 0); "Base Kit - Hiragana" 246 in stock | stock | price report |
| gmk-black-snail | Neo Macro | INR 6500 (was 7500), in stock | store **password-locked** (`/password`) | closed store shown as a live deal | price report |
| gmk-monochrome-dolch | Neo Macro | INR 15500 (was 17000), in stock | store **password-locked** | closed store shown as a live deal | price report |
| gmk-prussian-alert | Neo Macro | INR 14500, sold out | password-locked | already shown sold out; not filed | — |
| gmk-bent-r2 | NovelKeys | USD 135 (was 165) | novelkeys.xyz URL 301s to novelkeys.com "CYL Bento R2", 135 | price correct; stale domain in URL (redirect works) | — |
| gmk-dots-r2 / gmk-mika / gmk-stargaze | proto[Typist] | sold out | sold out; store shows a compare-at | sold out on both sides, so no visible error | — |
| gmk-mr-sleeves-r2 | Daily Clack | AUD 62, sold out | Light/Dark Kit 62, both sold out | consistent | — |

Follow-ups: Neo Macro is recorded as `LOCKED` by the price pass
(see price-report-ledger 2026-09-25), but its rows keep `inStock = true` and their
markdown, so they still qualify for "On sale". Worth deciding whether a LOCKED
row should drop out of the deals filter.
