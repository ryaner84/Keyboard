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

`after_slug` for the next run: **`gmk-cyl-hyperfuse-origins-r3-keycaps`**

The list held 51 on-sale sets on 2026-10-08 (gmk-evil-dolch has dropped off).
That run covered the 38 sets after the previous cursor (`gmk-finer-things …
gmk-zm`) and then wrapped to the top for 12 more (`dcs-dream-alert …
gmk-cyl-hyperfuse-origins-r3-keycaps`), 50 sets in all. The next run continues
after `gmk-cyl-hyperfuse-origins-r3-keycaps`. A 50-set batch now covers all but
one set, so a batch can start with `gmk-dots-r2`.

## Runs

| date | batch (first … last slug) | sets | listings | issues found | reports filed | audit run |
|---|---|---|---|---|---|---|
| 2026-09-26 | dcs-dream-alert … gmk-vamp | 50 | 271 | 12 flagged → 6 confirmed | 6 (price-report button) | [36223373383](https://github.com/ryaner84/Keyboard/actions/runs/36223373383) (reports: [36223666503](https://github.com/ryaner84/Keyboard/actions/runs/36223666503)) |
| 2026-09-27 | gmk-varenye … gmk-zm, wrap, dcs-dream-alert … gmk-vamp | 53 | 278 | 7 flagged → 2 confirmed | 2 (price-report button) | [36286575551](https://github.com/ryaner84/Keyboard/actions/runs/36286575551) + [36286576663](https://github.com/ryaner84/Keyboard/actions/runs/36286576663) (reports: [36286973228](https://github.com/ryaner84/Keyboard/actions/runs/36286973228)) |
| 2026-09-28 | gmk-varenye … gmk-zm, wrap, dcs-dream-alert … gmk-stargaze | 50 | 270 | 15 flagged → 3 confirmed | 3 (price-report button) | [36367279492](https://github.com/ryaner84/Keyboard/actions/runs/36367279492) + [36367394828](https://github.com/ryaner84/Keyboard/actions/runs/36367394828) (reports: [36367812617](https://github.com/ryaner84/Keyboard/actions/runs/36367812617)) |
| 2026-09-29 | gmk-tako … gmk-zm, wrap, dcs-dream-alert … gmk-red-devils | 50 | 273 | 11 flagged → 2 confirmed | 2 (price-report button) | [36509536114](https://github.com/ryaner84/Keyboard/actions/runs/36509536114) + [36509762528](https://github.com/ryaner84/Keyboard/actions/runs/36509762528) (reports: [36509979688](https://github.com/ryaner84/Keyboard/actions/runs/36509979688)) |
| 2026-09-30 | gmk-redline … gmk-zm, wrap, dcs-dream-alert … gmk-orange-alert | 50 | 268 | 11 flagged → 2 confirmed | 2 (price-report button) | [36656751452](https://github.com/ryaner84/Keyboard/actions/runs/36656751452) + [36656982393](https://github.com/ryaner84/Keyboard/actions/runs/36656982393) (reports: [36657385954](https://github.com/ryaner84/Keyboard/actions/runs/36657385954)) |
| 2026-10-01 | gmk-panda … gmk-zm, wrap, dcs-dream-alert … gmk-orange-alert | 50 | 262 | 16 flagged → 8 confirmed | 8 (price-report button) | [36802757204](https://github.com/ryaner84/Keyboard/actions/runs/36802757204) + [36803087195](https://github.com/ryaner84/Keyboard/actions/runs/36803087195) (reports: [36803622470](https://github.com/ryaner84/Keyboard/actions/runs/36803622470)) |
| 2026-10-02 | gmk-panda … gmk-zm, wrap, dcs-dream-alert … gmk-nightshade | 50 | 262 | 9 flagged → 1 confirmed | 1 (price-report button) | [36952559488](https://github.com/ryaner84/Keyboard/actions/runs/36952559488) + [36952665718](https://github.com/ryaner84/Keyboard/actions/runs/36952665718) (reports: [36952859148](https://github.com/ryaner84/Keyboard/actions/runs/36952859148)) |
| 2026-10-03 | gmk-nord … gmk-zm, wrap, dcs-dream-alert … gmk-mothman | 50 | 263 | 9 flagged + 1 unflagged → 2 confirmed | 2 (price-report button) | [37087385725](https://github.com/ryaner84/Keyboard/actions/runs/37087385725) + [37087515730](https://github.com/ryaner84/Keyboard/actions/runs/37087515730) (reports: [37087701521](https://github.com/ryaner84/Keyboard/actions/runs/37087701521)) |
| 2026-10-04 | gmk-mr-sleeves-r2 … gmk-zm, wrap, dcs-dream-alert … gmk-metropolis-r2 | 50 | 260 | 8 flagged + 1 unflagged → 1 confirmed | 1 (price-report button) | [37169065857](https://github.com/ryaner84/Keyboard/actions/runs/37169065857) + [37169067014](https://github.com/ryaner84/Keyboard/actions/runs/37169067014) (reports: [37169656893](https://github.com/ryaner84/Keyboard/actions/runs/37169656893)) |
| 2026-10-05 | gmk-mika … gmk-zm, wrap, dcs-dream-alert … gmk-maestro | 50 | 259 | 6 flagged + 2 unflagged → 2 confirmed | 2 (listing flag) | [37252749968](https://github.com/ryaner84/Keyboard/actions/runs/37252749968) + [37252751983](https://github.com/ryaner84/Keyboard/actions/runs/37252751983) (reports: [37253002800](https://github.com/ryaner84/Keyboard/actions/runs/37253002800)) |
| 2026-10-06 | gmk-manta … gmk-zm, wrap, dcs-dream-alert … gmk-hangulbeit-tkl | 50 | 262 | 9 flagged → 2 confirmed | 2 (price-report button) | [37400885163](https://github.com/ryaner84/Keyboard/actions/runs/37400885163) + [37400887830](https://github.com/ryaner84/Keyboard/actions/runs/37400887830) (reports: [37401348466](https://github.com/ryaner84/Keyboard/actions/runs/37401348466)) |
| 2026-10-07 | gmk-hazakura … gmk-zm, wrap, dcs-dream-alert … gmk-evil-dolch | 50 | 271 | 8 flagged + 2 unflagged → 2 confirmed | 2 (price-report button) | [37558774635](https://github.com/ryaner84/Keyboard/actions/runs/37558774635) + [37558777081](https://github.com/ryaner84/Keyboard/actions/runs/37558777081) (reports: [37559415669](https://github.com/ryaner84/Keyboard/actions/runs/37559415669)) |
| 2026-10-08 | gmk-finer-things … gmk-zm, wrap, dcs-dream-alert … gmk-cyl-hyperfuse-origins-r3-keycaps | 50 | 274 | 9 flagged → 1 confirmed | 1 (price-report button) | [37714709757](https://github.com/ryaner84/Keyboard/actions/runs/37714709757) + [37714712242](https://github.com/ryaner84/Keyboard/actions/runs/37714712242) (reports: [37715348211](https://github.com/ryaner84/Keyboard/actions/runs/37715348211)) |

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

### 2026-10-01 findings

Two audit runs (the 15 sets after the cursor, then a 35-set wrap) flagged 16
of 262 listings; the candidates were checked with the **Vendor probe**
([36803245099](https://github.com/ryaner84/Keyboard/actions/runs/36803245099)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| dcs-handarbeit | proto[Typist] | GBP 15.83, in stock | **"DCS Handarbeit - Base Kit + UKISO" 95**, in stock; "WASD" 15.83 | wrong variant: **regression from #201**. The "+ after base" rule made proto's only base a BUNDLE, and the dearest unlabelled line (WASD) beat it. Fixed here | price report |
| dcs-dream-alert | proto[Typist] | GBP 15, sold out | **"… Base Kit + UKISO Kit" 105.83**, sold out; "6.25u Kit" 15 | same regression | price report |
| gmk-cyl-finer-things-r2-keycaps | Keebz n Cables | AUD 144.12 (was 176.15), in stock | Teal / White Base **AUD 180**, in stock, no compare-at | wrong price and a markdown the store does not show; 144.06 is what `.json` serves a non-AU visitor | price report |
| gmk-finer-things | Keebz n Cables | AUD 144.12 (was 176.15), in stock | same R2 product page, AUD 180 | the R1 set links to the R2 product, at the converted price | price report |
| gmk-alt-grrrrr-addon | Keebz n Cables | AUD 15.21 (was 20.02), in stock | Dolch 16, Evil Dolch **19** | converted `.json` price, invented markdown | price report |
| gmk-orange-alert | Keebz n Cables | AUD 168.95, sold out | "TKL Base" **211**, sold out | converted `.json` price | price report |
| gmk-kitsune | KeyBay | CAD 158, in stock | "Base" **CAD 209**, in stock (`.js`); `.json` reads 158 | converted price stored as CAD | price report |
| gmk-manta | KeyBay | CAD 158, in stock | "Base" **CAD 209**, in stock | same | price report |
| gmk-botanical-r2 | Oblotzky Industries | EUR 139, in stock | "Standard" 139 | **#201 healed it** (was 159). Only the renamed handle is flagged | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" sold out; "Midnight Base" 70 available | site is right | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys, Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-09-30 | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |

Picker fix (both halves, `pickBaseVariant` / `choose_kit_variant`): when there
is no titled base but a bundle exists, an unlabelled variant priced under half
the cheapest bundle is a subkit, not the base, so it is dropped from the pool
and the cheapest bundle wins. Oblotzky's "Standard" (139 beside a 159 bundle)
is unaffected; the regression tests pin both shapes.

Follow-ups:
- Keebz n Cables (4 rows) and KeyBay (2 rows) all store the `.json` figure a
  non-home-market visitor is served, about 0.80× and 0.76× of the shelf price,
  and Keebz rows carry a compare-at the store does not show, which is what puts
  them on the deals page. Both stores are new to this list. The price pass's
  home-market pin evidently does not reach them; reading `.js` first (as the
  auditor does since 2026-09-28) would. Worth checking in the price-report
  review.

### 2026-10-02 findings

Two audit runs (the 16 sets after the cursor, then a 34-set wrap) flagged 9
of 262 listings; the candidates were checked with the **Vendor probe**
([36952672522](https://github.com/ryaner84/Keyboard/actions/runs/36952672522),
[36952795189](https://github.com/ryaner84/Keyboard/actions/runs/36952795189),
[36952810945](https://github.com/ryaner84/Keyboard/actions/runs/36952810945)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-varenye | GEONWORKS | USD 150, in stock | `group-buy-gmk-cyl-varenye` 302s to `geon.works/`; `gmk-cyl-varenye` and `gmk-varenye` 404 | dead link (front-door redirect), the gmk-mothman shape of 2026-09-28 | price report |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" 70 sold out; **"Midnight Base" 70 available** | site is right | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys, Oblotzky) / gmk-botanical-r2 (Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-10-01; stale handle in URL | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |

All eight rows reported on 2026-10-01 now read correct: dcs-handarbeit ×
proto[Typist] 95 GBP and dcs-dream-alert 105.83 GBP (the base + UKISO kit),
Keebz n Cables 180 / 180 / 19 / 211 AUD, KeyBay 209 / 209 CAD. #203's `.js`
shelf price holds.

Follow-up: the GEONWORKS row id is a UUID (`eea1e7ba-…`), not a discovery
`cm…` id, and it was stamped `upd=2026-10-01` while still showing a price and
in stock. A front-door redirect should have cleared it through `isGoneRedirect`.
It is not a curated link (`vendor-overrides.ts` names no geon.works URL), so
the price-report review should check why the price pass has not cleared it. The
store's search finds 5 "varenye" results, so the product may live under a new
handle.

### 2026-10-03 findings

Two audit runs (the 18 sets after the cursor, then a 32-set wrap) flagged 9 of
263 listings; the new candidates were checked with the **Vendor probe**
([37087613361](https://github.com/ryaner84/Keyboard/actions/runs/37087613361)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-2pack-add-on | Oblotzky Industries | EUR 32, **sold out** | "GMK CYL 2 Pack" 32, **available** (tagged pre-order) | stock | price report |
| gmk-2pack-add-on | Swagkeys | AUD 44.99 (was 49.99), in stock | link is **switchkeys.com.au**/products/gmk-2pack, "GMK 2PACK" 44.99 AUD | **wrong vendor**: SwitchKeys' listing filed on the Swagkeys row (Swagkeys is a KR store quoting USD). Not flagged by the auditor, which checks the page, not whose page it is | price report |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" 70 sold out; "Midnight Base" 70 available | site is right (as 2026-09-30) | — |
| gmk-hazakura | DeskHero | CAD 246, in stock | "Base Kit" sold out; "Base Kit - Hiragana" 246 in stock | site is right (as 2026-09-27); not flagged | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys, Oblotzky) / gmk-botanical-r2 (Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-10-02; stale handle in URL | — |

gmk-2pack-add-on is new to the on-sale list (53 sets, up from 52).
gmk-varenye × GEONWORKS (reported 2026-10-02) no longer appears among the
priced listings, so its dead-link clear has landed.

Follow-up: the auditor has no check that a listing's host belongs to its
vendor. A `HOST_MISMATCH` verdict (listing host ≠ the vendor's `websiteUrl`
host) would have caught the Swagkeys/SwitchKeys row; the name collision looks
like an upstream KeycapLendar mis-filing that host-based vendor matching
(`nextVendorWebsiteUrl`, `planStorefrontOwnership`) does not reach for a single
listing.

### 2026-10-04 findings

Two audit runs (the 21 sets after the cursor, then a wrap; only the first 29
sets of the wrap run, 149 of its 262 listings, belong to this batch) flagged 8
of 260 listings, all of them known stale-handle or pinned-variant shapes. One
unflagged listing was wrong, and the **Vendor probe**
([37169634084](https://github.com/ryaner84/Keyboard/actions/runs/37169634084))
confirmed it:

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-black-snail---red-cyrillic-addon | Neo Macro | INR 6500 (was 7500), in stock | no base kit: L9 Modifier 6000, **U9 Modifier 6500**, 40s Ortho 4900, **Red Cyrillic Alphas 9900**, accents, numpad, Retro Point 600, all available | **recurrence** of 2026-09-28: wrong variant. #198 cleared this row to null, but it is priced again from the U9 Modifier Kit. Not flagged by the auditor because its "price match" accepts any variant at the site's price | price report |
| gmk-2pack-add-on | Oblotzky Industries | EUR 32, in stock | "GMK CYL 2 Pack" 32 available | **healed** (reported 2026-10-03) | — |
| gmk-2pack-add-on | Swagkeys | AUD 44.99 (was 49.99) | switchkeys.com.au listing on the Swagkeys row | still the wrong vendor; held for the owner by the 2026-10-03 price-report review. Not refiled | — |
| gmk-monochrome-dolch | Neo Macro | INR 15500 (was 17000), in stock | "Full Base" 15500 available; store open again | correct | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" sold out; "Midnight Base" 70 available | site is right (as 2026-09-30) | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys, Oblotzky) / gmk-botanical-r2 (Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-10-03; stale handle in URL | — |

A host check over every listing in the batch found no other vendor/host mismatch
besides Swagkeys → switchkeys.com.au.

Follow-up for the price-report review: the add-on set's name contains "Addon",
so `isSubkitSetName` is true and `allowSubkits` lets the modifier kits back into
the pool, where the dearest-unlabelled rule takes U9 Modifier (6500). On a set
named for the Red Cyrillic add-on, the matching variant is "Red Cyrillic
Alphas" (9900). Either the subkit-set pick should prefer the variant that
matches the set's own add-on name, or this set row (a near-duplicate of
gmk-black-snail, see 2026-09-28) should go. The vendor kit id is
`cmuslcupj000n04igkpdo3hmn`. It was created on the same day as the
re-created Toro Studios row (`cmuslc…`), so the row may have been re-created
rather than re-priced.

### 2026-10-05 findings

Two audit runs (the 25 sets after the cursor, then a wrap; only the first 25
sets of the wrap run, 123 of its 266 listings, belong to this batch) flagged 6
of 259 listings. All 6 are stale-handle or pinned-variant cases already in this
ledger. Two problems the auditor does not check for (set identity and vendor
identity) were confirmed with the **Vendor probe**
([37252951369](https://github.com/ryaner84/Keyboard/actions/runs/37252951369))
and filed through the listing flag (`duplicate`):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-finer-things | Keebz n Cables, Aiglatson Studio, Mecha MY, Daily Clack | Keebz AUD 180 (was 220), **in stock**, shown as a deal | every product is **"GMK Finer Things R2"** (Keebz: "[Pre-order] GMK Finer Things R2 Keycaps", Teal/White Base 180 available) | the R1 set row carries the R2 product's listings, which also sit on `gmk-cyl-finer-things-r2-keycaps`. The 2026-10-01 price report fixed the price only, so the wrong-product half was still open | listing flag |
| gmk-cyl-finer-things-r2-keycaps (and gmk-finer-things) | Mecha MY + Mecha.store | MYR 459, sold out, listed twice | `mecha.store/products/group-buy-gmk-finer-things-r2` 301s to `www.mecha.com.my/…` | **one shop on two Vendor rows**, the Toro Studio / Toro Studios shape | listing flag |
| gmk-black-snail---red-cyrillic-addon | Neo Macro | INR 6500 (was 7500), in stock | U9 Modifier Kit 6500 (no base kit) | still the wrong variant; held for the owner by the 2026-10-04 price-report review. Not refiled | — |
| gmk-2pack-add-on | Swagkeys | AUD 44.99 (was 49.99) | switchkeys.com.au listing | still the wrong vendor; held for the owner since 2026-10-03. Not refiled | — |
| gmk-varenye | Toro Studio + Toro Studios | AUD 245 ×2 | same URL | duplicate vendor rows (as 2026-09-28); still unmerged | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" sold out; "Midnight Base" 70 available | site is right (as 2026-09-30) | — |
| gmk-hazakura | DeskHero | CAD 246, in stock | "Base Kit" sold out; "Base Kit - Hiragana" 246 in stock | site is right (as 2026-09-27) | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys) / gmk-botanical-r2 (Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-10-04; stale handle in URL | — |

Everything else matched the store on price, markdown and stock.

Follow-up: Mecha.store is in no roster entry (`src/data/seed/vendors.json` names
no Mecha shop), so `mergeDuplicateVendorRows` cannot fold the pair until a
roster entry carries both slugs (`aliases`). Toro Studio / Toro Studios is
different: the roster already lists `toro-studios` as an alias of `toro-studio`,
yet both rows still show on gmk-varenye. The Toro Studios VendorKit id
(`cmuu0so0k…`) is newer than the one recorded on 2026-09-28, so the duplicate row
appears to be merged on deploy and then re-created by an import. Worth a look in
the price-report review.

### 2026-10-06 findings

Two audit runs (the 29 sets after the cursor, then a wrap; only the first 21
sets of the wrap run, 101 of its 266 listings, belong to this batch) flagged 9
of 262 listings. Seven are stale-handle or pinned-variant cases already in this
ledger. The two new ones were confirmed with the **Vendor probe**
([37401216836](https://github.com/ryaner84/Keyboard/actions/runs/37401216836)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-masterpiece-r2 | iLumKB | SGD 159, **sold out** (upd 2026-10-05) | "[Pre-Order] GMK CYL Masterpiece R2": Origin Base 159 **available** | stock: the site hides a buyable pre-order | price report |
| gmk-cyl-hyperfuse-origins-r3-keycaps | Oblotzky Industries | EUR 125, **sold out** (upd 2026-10-05) | Base 125 **available** (tagged `pre-order`) | stock: same shape | price report |
| gmk-black-snail---red-cyrillic-addon | Neo Macro | INR 6500 (was 7500), in stock | U9 Modifier Kit 6500 | still the wrong variant; held for the owner since 2026-10-04. Not refiled | — |
| gmk-2pack-add-on | Swagkeys | AUD 44.99 (was 49.99) | switchkeys.com.au listing | still the wrong vendor; held since 2026-10-03. Not refiled | — |
| gmk-finer-things / gmk-cyl-finer-things-r2-keycaps | Mecha MY + Mecha.store, R1 row carrying R2 listings | — | — | flagged 2026-10-05; still unmerged. Not refiled | — |
| gmk-varenye | Toro Studio + Toro Studios | AUD 245 ×2 | same URL | duplicate vendor rows (as 2026-09-28); still unmerged | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" sold out; "Midnight Base" 70 available | site is right (as 2026-09-30) | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys) / gmk-botanical-r2 (Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-10-05; stale handle in URL | — |

gmk-zm × SwitchKeys now reads AUD 229.99 in stock through a redirect to
`/products/gmk-zimo`, so the 404 reported on 2026-09-27 has healed at the store's
end. Everything else matched the store on price, markdown and stock.

Both stock errors are rows last read on 2026-10-05 while their set siblings were
read on 2026-10-06, so the next price pass may correct them by itself. Check them
in the next price-report review.

### 2026-10-07 findings

Two audit runs (the 34 sets after the cursor, then a wrap; only the first 16
sets of the wrap run, 79 of its 272 listings, belong to this batch) flagged 8
of 271 listings, all of them stale-handle, pinned-variant or unreadable-platform
cases. Two unflagged listings were wrong. The auditor passed them because a
single-variant product counts as a match. The **Vendor probe**
([37559225235](https://github.com/ryaner84/Keyboard/actions/runs/37559225235))
confirmed both:

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-evil-dolch | SwiftCables | USD 39.5 (was 70), **in stock**, the set's only in-stock listing | `gmk-evil-dolch-extras`: "GMK Evil Dolch Extras", one Default Title variant at 39.50, a cable | **wrong product**. This is the cable listing dropped from gmk-evil-dolch-r2 by `BLOCKED_VENDOR_SET_PAIRS` (`swiftcables::gmk-evil-dolch-r2`), and it now sits on the R1 set row. The pair block covers one set slug only | price report |
| gmk-aurora-polaris | SwiftCables | USD 45 (was 75), in stock | `gmk-aurora-polaris-extras`: "GMK Aurora Polaris Extras", one Default Title variant at 45.00 | wrong product: same SwiftCables `-extras` cable shape | price report |
| gmk-monochrome-r2 | FunKeys | UAH 4300, sold out | Tilda page, 200, no price markup (the auditor has no Tilda reader); page text says the shipment is delayed | can't be checked by the auditor; shown sold out, so no misleading Buy button. Not filed | — |
| gh-116846 | iLumKB | SGD 79.5 (was 159), in stock | "[In Stock] MW Stone Age Keycap Set": "Base(Brand New Opened Set)" 79.50 available, Novelties 49 | price and stock match. The markdown is for an **opened-box** unit, which the site does not say. Not filed | — |
| gmk-mr-sleeves-r2 | NovelKeys / iLumKB | USD 10 sold out / SGD 29.7 in stock | Original/New Sleeves 10 (sold out); Light/Dark Kit 29.70 (available) | correct (clearance) | — |
| gmk-relegendables | Omnitype | USD 6.99 (was 9.99) | "WS1 (10)" 6.99, a 10-pack of relegendable caps | matches the store; the product is an accessory pack. Not filed | — |
| gmk-masterpiece-r2 (iLumKB), gmk-cyl-hyperfuse-origins-r3-keycaps (Oblotzky) | — | now in stock | available | **healed** (reported 2026-10-06) | — |
| gmk-2pack-add-on | Swagkeys | AUD 44.99 (was 49.99) | switchkeys.com.au listing | still the wrong vendor; held since 2026-10-03. Not refiled | — |
| gmk-finer-things / gmk-cyl-finer-things-r2-keycaps | Mecha MY + Mecha.store, R1 row carrying R2 listings | — | — | flagged 2026-10-05; still unmerged. Not refiled | — |
| gmk-varenye | Toro Studio + Toro Studios | AUD 245 ×2 | same URL | duplicate vendor rows (as 2026-09-28); still unmerged | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" sold out; "Midnight Base" 70 available | site is right (as 2026-09-30) | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys) / gmk-botanical-r2 (Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-10-06; stale handle in URL | — |

gmk-black-snail and gmk-black-snail---red-cyrillic-addon are no longer on the
on-sale list. Everything else matched the store on price, markdown and stock.

Follow-up for the price-report review: SwiftCables is a cable maker whose
`/products/gmk-<set>-extras` pages are cables named after a keycap set.
Blocking one vendor-set pair at a time does not hold, because the evil-dolch
cable came back on the sibling set. A vendor-wide rule would hold: no
SwiftCables `-extras` listing on any set. Check gmk-mika × SwiftCables
(`gmk-mika-keycaps-1`, "Base Kit" 79) before applying it, because that one is a
real keycap product.

### 2026-10-08 findings

Two audit runs covered this batch. The first took the 38 sets after the cursor.
The second wrapped to the start, and only its first 12 sets (63 of its 274
listings) belong to this batch. Between them they flagged 9 of 274 listings.
Eight are stale-handle, pinned-variant or unreadable-platform cases already in
this ledger. The new one was confirmed with the **Vendor probe**
([37715214379](https://github.com/ryaner84/Keyboard/actions/runs/37715214379)):

| set | vendor | site | store | verdict | filed |
|---|---|---|---|---|---|
| gmk-thunder-god | proto[Typist] | GBP 157, in stock | "(In Stock) GMK CYL Thunder God": **Base Kit 115.83** available, Novelties Kit 29.17 | wrong price: no variant on the page is 157 | price report |
| gmk-monochrome-r2 | FunKeys | UAH 4300, sold out | Tilda page, no price markup the auditor can read | as 2026-10-07; shown sold out. Not filed | — |
| gmk-metropolis-r2 | NovelKeys | USD 70 (was 135), in stock | "Base" sold out; "Midnight Base" 70 available | site is right (as 2026-09-30) | — |
| gmk-camping-r3 | NovelKeys | — | — | as 2026-09-27 (pinned leftovers variant correct) | — |
| gmk-wasabi-r2 / gmk-zm (SwitchKeys, Mekibo) / gmk-dots-r2 (NovelKeys) / gmk-botanical-r2 (Oblotzky) | — | — | renamed handles redirect to the same product and price | as 2026-10-07; stale handle in URL | — |
| gmk-2pack-add-on | Swagkeys | AUD 44.99 (was 49.99) | switchkeys.com.au listing | still the wrong vendor; held since 2026-10-03. Not refiled | — |
| gmk-finer-things / gmk-cyl-finer-things-r2-keycaps | Mecha MY + Mecha.store, R1 row carrying R2 listings | — | — | flagged 2026-10-05; still unmerged. Not refiled | — |
| gmk-varenye | Toro Studio + Toro Studios | AUD 245 ×2 | same URL | duplicate vendor rows (as 2026-09-28); still unmerged | — |

gmk-evil-dolch and gmk-aurora-polaris (yesterday's SwiftCables cable listings)
are no longer on the on-sale list, so the vendor-wide `-extras` block from
6e74210 has taken effect. Everything else matched the store on price, markdown
and stock.
