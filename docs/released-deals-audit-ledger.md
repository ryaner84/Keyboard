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

`after_slug` for the next run: **`gmk-stargaze`**

The list held 55 on-sale sets on 2026-09-28. That run covered the 3 sets left
after the previous cursor (`gmk-varenye … gmk-zm`) and then wrapped to the top
for 47 more (`dcs-dream-alert … gmk-stargaze`), 50 sets in all. The next run
continues after `gmk-stargaze`.

## Runs

| date | batch (first … last slug) | sets | listings | issues found | reports filed | audit run |
|---|---|---|---|---|---|---|
| 2026-09-26 | dcs-dream-alert … gmk-vamp | 50 | 271 | 12 flagged → 6 confirmed | 6 (price-report button) | [36223373383](https://github.com/ryaner84/Keyboard/actions/runs/36223373383) (reports: [36223666503](https://github.com/ryaner84/Keyboard/actions/runs/36223666503)) |
| 2026-09-27 | gmk-varenye … gmk-zm, wrap, dcs-dream-alert … gmk-vamp | 53 | 278 | 7 flagged → 2 confirmed | 2 (price-report button) | [36286575551](https://github.com/ryaner84/Keyboard/actions/runs/36286575551) + [36286576663](https://github.com/ryaner84/Keyboard/actions/runs/36286576663) (reports: [36286973228](https://github.com/ryaner84/Keyboard/actions/runs/36286973228)) |
| 2026-09-28 | gmk-varenye … gmk-zm, wrap, dcs-dream-alert … gmk-stargaze | 50 | 270 | 15 flagged → 3 confirmed | 3 (price-report button) | [36367279492](https://github.com/ryaner84/Keyboard/actions/runs/36367279492) + [36367394828](https://github.com/ryaner84/Keyboard/actions/runs/36367394828) (reports: [36367812617](https://github.com/ryaner84/Keyboard/actions/runs/36367812617)) |

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

### 2026-09-27 findings

Two audit runs (the 3 sets after the cursor, then a wrap for 50) flagged 7 of
278 listings; each was checked with the **Vendor probe**
([36286753743](https://github.com/ryaner84/Keyboard/actions/runs/36286753743)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-panda | iLumKB | SGD 229, in stock | "Base" 229 **sold out**; "Base+Nov+Space" 329 in stock | **recurrence** of 2026-09-26: the abbreviated bundle classified BASE, and stock is read across every BASE variant. Fixed here (`nov`/`space` join the bundle vocabulary in both halves) | price report |
| gmk-zm | SwitchKeys | AUD 229.99, in stock | 404 (also `/products/gmk-zimo-group-buy`, `gmk-cyl-zimo`) | dead link | price report |
| gmk-hazakura | DeskHero | CAD 246, in stock | "Base Kit" sold out; "Base Kit - Hiragana" 246 **in stock** | site is right — a base kit is buyable at 246. Auditor false positive (it compared the first price match); fixed in the audit script. Yesterday's report on this row was the same false positive | — |
| gmk-zm | Mekibo | USD 160 (was 180) | `gmk-zimo-group-buy` 301s to `gmk-zimo`, Base 160 (was 180) | price/markdown correct; stale handle in URL (redirect works) | — |
| gmk-bent-r2 | NovelKeys | USD 135 (was 165) | novelkeys.xyz 301s to novelkeys.com, 135 (was 165) | as 2026-09-26; redirect works | — |
| gmk-camping-r3 | NovelKeys | USD 135, in stock | "GMK Leftovers" product, variant "Camping R3 Classic Base" 135 in stock | correct — pinned `?variant=` on a leftovers listing | — |
| gmk-prussian-alert | Neo Macro | INR 14500, sold out | password-locked | already sold out and LOCKED; not filed | — |

Follow-up for the price-report routine: gmk-panda × iLumKB should read sold
out after the next price pass with this fix deployed; gmk-zm × SwitchKeys
should lose its price on the next pass's 404 (DEAD_LINK).

### 2026-09-28 findings

Two audit runs (the 3 sets after the cursor, then a 47-set wrap) flagged 15 of
270 listings; the candidates were checked with the **Vendor probe**
([36367580437](https://github.com/ryaner84/Keyboard/actions/runs/36367580437),
[36367598420](https://github.com/ryaner84/Keyboard/actions/runs/36367598420)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-black-snail | Neo Macro | INR 6500 (was 7500), in stock | **no base kit**: L9 Modifier Kit 6000, **U9 Modifier Kit 6500**, 40s Ortho 4900, Red Cyrillic Alphas 9900, accents, numpad, GMK Retro Point 600 | wrong variant: the picker took the dearest unlabeled line. Fixed here (`modifier` and `retro point` join `NONBASE_SUBKIT_RE` in both halves), so the row clears to NO_BASE_KIT | price report |
| gmk-black-snail---red-cyrillic-addon | Neo Macro | INR 6500 (was 7500), in stock | same product | same | price report |
| gmk-mothman | GEONWORKS | USD 150, in stock | `group-buy-gmk-cyl-mothman` 302s to `geon.works/` | dead link (front-door redirect) | price report |
| gmk-black-snail, gmk-black-snail---red-cyrillic-addon, gmk-evil-dolch, gmk-monochrome-dolch | Cafege | AUD 160 / 165 / 240 | `.js` shelf price 160 / 165 / 240, matching the site | site is right. `.json` served ex-GST (÷1.1) because the auditor's `/meta.json` read failed, so no home-market pin was sent. Auditor false positive; fixed in the audit script (prices from `.js` first) | — |
| gmk-black-snail, gmk-cyl-finer-things-r2-keycaps, gmk-gurokawa, gmk-orange-alert, gmk-prussian-alert | Yushakobo | JPY 13200 / 19800 / 24200 / 22440 / 25520 | `.js` 13200 etc., `.json` ex consumption tax | same auditor false positive | — |
| gmk-masterpiece-r2 | NovelKeys | USD 120 (was 130), in stock | Origin Base 120, in stock | correct; the audit's 503 was transient | — |
| gmk-zm | SwitchKeys | AUD 229.99, in stock | 404 | already reported 2026-09-27; still published, so the dead-link clear has not reached it yet. Watch it | — |
| gmk-zm | Mekibo | USD 160 (was 180) | redirect to `gmk-zimo`, Base 160 (was 180) | as 2026-09-27; redirect works | — |
| gmk-bent-r2 / gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (xyz redirect works; pinned leftovers variant correct) | — |

Follow-ups:
- `gmk-black-snail---red-cyrillic-addon` is an add-on set whose BASE listings
  (Cafege, Neo Macro, NovelKeys) are the Black Snail base-kit products. It looks
  like a duplicate or mis-typed set row rather than a price error, so it was not
  filed beyond the Neo Macro price.
- gmk-varenye lists **Toro Studio** and **Toro Studios** side by side, one shop
  on two Vendor rows with identical prices. `mergeDuplicateVendorRows` should fold
  them; the `cmuk0…` row ids suggest the duplicate was re-created recently.

