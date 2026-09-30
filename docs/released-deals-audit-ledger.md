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

`after_slug` for the next run: **`gmk-orange-alert`**

The list held 53 on-sale sets on 2026-09-30. That run covered the 13 sets left
after the previous cursor (`gmk-redline … gmk-zm`) and then wrapped to the top
for 37 more (`dcs-dream-alert … gmk-orange-alert`), 50 sets in all. The next
run continues after `gmk-orange-alert`.

## Runs

| date | batch (first … last slug) | sets | listings | issues found | reports filed | audit run |
|---|---|---|---|---|---|---|
| 2026-09-26 | dcs-dream-alert … gmk-vamp | 50 | 271 | 12 flagged → 6 confirmed | 6 (price-report button) | [36223373383](https://github.com/ryaner84/Keyboard/actions/runs/36223373383) (reports: [36223666503](https://github.com/ryaner84/Keyboard/actions/runs/36223666503)) |
| 2026-09-27 | gmk-varenye … gmk-zm, wrap, dcs-dream-alert … gmk-vamp | 53 | 278 | 7 flagged → 2 confirmed | 2 (price-report button) | [36286575551](https://github.com/ryaner84/Keyboard/actions/runs/36286575551) + [36286576663](https://github.com/ryaner84/Keyboard/actions/runs/36286576663) (reports: [36286973228](https://github.com/ryaner84/Keyboard/actions/runs/36286973228)) |
| 2026-09-28 | gmk-varenye … gmk-zm, wrap, dcs-dream-alert … gmk-stargaze | 50 | 270 | 15 flagged → 3 confirmed | 3 (price-report button) | [36367279492](https://github.com/ryaner84/Keyboard/actions/runs/36367279492) + [36367394828](https://github.com/ryaner84/Keyboard/actions/runs/36367394828) (reports: [36367812617](https://github.com/ryaner84/Keyboard/actions/runs/36367812617)) |
| 2026-09-29 | gmk-tako … gmk-zm, wrap, dcs-dream-alert … gmk-red-devils | 50 | 273 | 11 flagged → 2 confirmed | 2 (price-report button) | [36509536114](https://github.com/ryaner84/Keyboard/actions/runs/36509536114) + [36509762528](https://github.com/ryaner84/Keyboard/actions/runs/36509762528) (reports: [36509979688](https://github.com/ryaner84/Keyboard/actions/runs/36509979688)) |
| 2026-09-30 | gmk-redline … gmk-zm, wrap, dcs-dream-alert … gmk-orange-alert | 50 | 268 | 11 flagged → 2 confirmed | 2 (price-report button) | [36656751452](https://github.com/ryaner84/Keyboard/actions/runs/36656751452) + [36656982393](https://github.com/ryaner84/Keyboard/actions/runs/36656982393) (reports: [36657385954](https://github.com/ryaner84/Keyboard/actions/runs/36657385954)) |

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


### 2026-09-29 findings

Two audit runs (the 9 sets after the cursor, then a 41-set wrap) flagged 11 of
273 listings; the candidates were checked with the **Vendor probe**
([36509765122](https://github.com/ryaner84/Keyboard/actions/runs/36509765122),
[36509926245](https://github.com/ryaner84/Keyboard/actions/runs/36509926245)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-wasabi-r2 | SwitchKeys | AUD 199 (was 239.99), in stock | collection URL 404s; `/products/gmk-wasabi-v2-group-buy` 301s to `gmk-wasabi-v2` "GMK Wasabi V2", **Wasabi Base 143** | wrong price: the link lands on a page selling the base at 143 | price report |
| gmk-botanical-r2 | Oblotzky Industries | EUR 159, in stock | `gmk-botanical-2` redirects to `gmk-cyl-botanical-2`: "Standard" **139** in stock; "Standard Base + Hibi & Botanical Leaf" 159 | wrong variant: the picker took a base + artisan bundle over the base kit titled plain "Standard" | price report |
| gmk-zm | SwitchKeys | AUD 229.99, in stock | stored handle 301s to `gmk-zimo`: **Base 165** | same shape as gmk-wasabi-r2. The 2026-09-28 price-report review settled this as live and priced (an owner relink decision), so not refiled; the landing page's own base price is 165 | — |
| gmk-dots-r2 | Daily Clack | AUD 129, no markdown shown | "Dots Dark - Base Kit" 129 (compare-at 230), in stock | price and stock right; the site shows no markdown the store does. Not filed | — |
| gmk-finer-things | CannonKeys | USD 109, sold out | `gb-gmk-finer-things` 301s to `gmk-finer-things`, now titled **"GMK Finer Things R2"** (Teal/White Base 109) | the R1 set's link now reaches the R2 product. Shown sold out, so not filed; a relink/catalog question | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | xyz collection URL 404s; `/products/` form redirects to `gmk-cyl-metropolis-r2-keycaps`, Base 70 | correct; auditor false positive (see below) | — |
| gmk-botanical-r2 / gmk-centinela-extension-kits / gmk-dots-r2 (NovelKeys, Oblotzky) / gmk-zm (Mekibo) | — | — | renamed handles redirect to the same product and price | correct; stale handle in URL | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |

Auditor fix: the human-page fallback now reads the unscoped `/products/<handle>`
URL, the way the price pass does (`normalizeShopifyUrl`), instead of the
`/collections/<c>/products/<h>` alias. A store that drops a product from a
collection 404s the alias while the product page still redirects, which is how
gmk-zm × SwitchKeys was reported as dead on 2026-09-27 and how gmk-wasabi-r2,
gmk-finer-things and gmk-metropolis-r2 read as dead links here.

Follow-ups:
- Picker: a variant titled plain "Standard" (Oblotzky's base kit) loses to
  "Standard Base + <artisan>". `+` bundles with a base should not outrank a
  lone variant when that variant is the cheapest full kit.
- SwitchKeys renames GB products to their in-stock handle (`-group-buy` →
  plain), and the site keeps an older price the landing page no longer shows,
  on two sets now (gmk-zm, gmk-wasabi-r2).

### 2026-09-30 findings

Two audit runs (the 13 sets after the cursor, then a 37-set wrap) flagged 11
of 268 listings; the candidates were checked with the **Vendor probe**
([36656989840](https://github.com/ryaner84/Keyboard/actions/runs/36656989840),
[36657302686](https://github.com/ryaner84/Keyboard/actions/runs/36657302686)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-masterpiece-r2 | Oblotzky Industries | EUR 119, **sold out** | "Origin Base" 119 **available** (tagged pre-order; Roman Base 139 also available) | stock | price report |
| gmk-varenye | iLumKB | SGD 209, **sold out** | "[Group Buy] GMK CYL Varenye": "Full Base" 209 **available**, TKL Base 179 available | stock | price report |
| gmk-wasabi-r2 | SwitchKeys | AUD 199 (was 239.99), in stock | `gmk-wasabi-v2` `.js`: "Wasabi Base" **199** available; the `.json` served a US runner reads 142 (geo-converted: Latin Alphas 49.99 → 36) | site is right. **The 2026-09-29 report on this row (143) was an auditor false positive** — the `.json` price in a converted currency, not the store's AUD. The price-report review should dismiss it rather than act on it | — |
| gmk-botanical-r2 | Oblotzky Industries | EUR 159, in stock | "Standard" 139 in stock; "Standard Base + Hibi & Botanical Leaf" 159 | still the bundle; reported 2026-09-29 and awaiting the picker follow-up below. Not refiled | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" 70 sold out; **"Midnight Base" 70 available** | site is right — a base kit is buyable at 70 | — |
| gmk-zm | SwitchKeys / Mekibo | AUD 229.99 / USD 160 (was 180) | renamed handles redirect to `gmk-zimo`, same price | as 2026-09-29; stale handle in URL | — |
| gmk-dots-r2 (NovelKeys, Oblotzky) / gmk-finer-things (CannonKeys) | — | — | renamed handles redirect to the same product and price | as 2026-09-29 | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |

Follow-ups:
- Both stock errors were read by the price pass on 2026-09-29 and are stored
  sold out while `.js` says available now. `refreshPrices` takes availability
  from `.js` across every BASE variant, so this looks like a reopen after the
  last read (Masterpiece R2's variants are newly created pre-order ones) rather
  than a reader bug. Check whether the next pass heals them.
- The 2026-09-29 gmk-zm × SwitchKeys note ("the landing page's own base price
  is 165") came from the same `.json` geo-conversion as the wasabi report; the
  store's `.js` today says 229.99, matching the site.
