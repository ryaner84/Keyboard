import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dedupeKey,
  normalizeSetName,
  stripRound,
  roundNumber,
  setMaker,
  KEYCAP_MAKER_LABELS,
  MAKER_NAME_PREFIXES,
  makerWhereOr,
  isKeycapMaker,
  displaySetName,
  TRACKED_PROFILES,
  TRACKED_PROFILE_RE,
} from "@/lib/set-name";

// --- normalizeSetName keeps DCS distinct from GMK -------------------------
// This is the key the vendor-listing matcher uses. It strips GMK's own default
// profile tokens (cyl/mtnu handled elsewhere) but must NOT conflate profiles.
assert.notEqual(normalizeSetName("DCS Dolch"), normalizeSetName("GMK Dolch"));
assert.equal(normalizeSetName("GMK CYL Bento Keycaps"), normalizeSetName("GMK Bento"));

// --- dedupeKey: profile is identity for keycaps, noise for keyboards -------

// KEYCAPS (keepProfile: true) — "DCS Dolch" is a Signature Plastics set and
// "GMK Dolch" is a different product. Collapsing them would merge two unrelated
// sets into one listing.
assert.notEqual(
  dedupeKey("DCS Dolch", { keepProfile: true }),
  dedupeKey("GMK Dolch", { keepProfile: true })
);
// The gmk.net and community spellings of ONE set still collapse.
assert.equal(
  dedupeKey("GMK CYL Bento Keycaps", { keepProfile: true }),
  dedupeKey("GMK Bento", { keepProfile: true })
);
// DCS spellings of one set collapse with each other.
assert.equal(
  dedupeKey("[GB] DCS Superweld", { keepProfile: true }),
  dedupeKey("DCS Superweld Keycaps", { keepProfile: true })
);
// MTNU stays distinct in both modes.
assert.notEqual(
  dedupeKey("GMK MTNU Divinapapaya", { keepProfile: true }),
  dedupeKey("GMK Divinapapaya", { keepProfile: true })
);
assert.notEqual(dedupeKey("GMK MTNU Divinapapaya"), dedupeKey("GMK Divinapapaya"));

// KEYBOARDS (default) — here "DCS Dolch" only describes the bundled caps, so the
// three spellings of one board must still collapse to a single listing.
const seal80 = [
  "Sensy Seal80 Dolch Edition Keyboard Kit",
  "SENSY Seal80 Keyboard Kit — DCS Dolch Special Edition (Group Buy)",
  "(Group Buy) Sensy Seal80 Keyboard Kit - DCS Dolch Special Edition",
].map((name) => dedupeKey(name));
assert.equal(new Set(seal80).size, 1, `Seal80 spellings should collapse: ${JSON.stringify(seal80)}`);

// Rounds are never merged, in either mode.
assert.notEqual(dedupeKey("GMK Noel"), dedupeKey("GMK Noel R2"));
assert.notEqual(
  dedupeKey("DCS Cream Cheese and Green", { keepProfile: true }),
  dedupeKey("DCS Cream Cheese and Green R3", { keepProfile: true })
);

// --- round helpers --------------------------------------------------------
assert.equal(stripRound(normalizeSetName("GMK Striker R2")), "gmk striker");
assert.equal(roundNumber(normalizeSetName("GMK Striker Round 3")), 3);
assert.equal(roundNumber(normalizeSetName("GMK Striker")), 1);

// --- setMaker: who MAKES the set, which is not the same as its profile ----
// GMK makes Cherry-profile sets plus the CYL and MTNU profiles. Signature
// Plastics makes DCS *and* SA — they are sibling profiles from one factory,
// not a parent/child pair, which is why the pill is labelled by maker.
assert.equal(setMaker("GMK Botanical"), "GMK");
assert.equal(setMaker("GMK CYL Zombie"), "GMK");
// No "GMK" token anywhere in the name — a plain name check would miss it.
assert.equal(setMaker("MTNU Electronic Control"), "GMK");

assert.equal(setMaker("DCS Soju"), "SP");
assert.equal(setMaker("DCS 9009"), "SP");
assert.equal(setMaker("SA Laser"), "SP");

// The two makers must never collide for the same colourway.
assert.notEqual(setMaker("DCS Dolch"), setMaker("GMK Dolch"));

// Geekhack thread titles carry bracketed tags before the profile token.
assert.equal(setMaker("[GB] DCS Mermaid | Running Oct 17 - Nov 14"), "SP");
assert.equal(setMaker("(Group Buy) GMK Bento"), "GMK");

// Unknown or absent profile -> null, so the set stays visible under "all"
// instead of being silently filed under the wrong maker.
assert.equal(setMaker("KAT Milkshake"), null);
assert.equal(setMaker("Mystery Set"), null);
assert.equal(setMaker(""), null);
// A profile token that is not the FIRST word does not decide the maker:
// "Seal80 - DCS Dolch Edition" is a keyboard bundling DCS caps, not a DCS set.
assert.equal(setMaker("Sensy Seal80 Dolch Edition Keyboard Kit"), null);

// Labels are what the pills render; SP must not read as "SA".
assert.equal(KEYCAP_MAKER_LABELS.GMK, "GMK");
assert.equal(KEYCAP_MAKER_LABELS.SP, "Signature Plastics");

// --- makerWhereOr: the SQL-side twin of setMaker ---------------------------
// The two must agree, or /browse and /released would disagree about which
// sets belong to which maker.
assert.equal(isKeycapMaker("GMK"), true);
assert.equal(isKeycapMaker("SP"), true);
assert.equal(isKeycapMaker("SA"), false);

const spOr = makerWhereOr(["SP"]);
const spJson = JSON.stringify(spOr);
// Catalog rows match on the name prefix, Geekhack rows on the post-tag form.
assert.ok(spJson.includes('"startsWith":"DCS"'), spJson);
assert.ok(spJson.includes('"contains":"] DCS"'), spJson);
// Slug prefixes are the fallback for hand-edited display names.
assert.ok(spJson.includes('"startsWith":"dcs-"'), spJson);
// SP must never reach for GMK's profiles.
assert.ok(!spJson.includes('"startsWith":"GMK"'), spJson);

const gmkOr = makerWhereOr(["GMK"]);
const gmkJson = JSON.stringify(gmkOr);
assert.ok(gmkJson.includes('"startsWith":"MTNU "'), gmkJson);
assert.ok(!gmkJson.includes('"startsWith":"DCS"'), gmkJson);

// "SA " keeps its trailing space: a bare "SA" prefix would swallow the GMK
// sets "Salamander" and "Sanctuary".
assert.ok(spJson.includes('"startsWith":"SA "'), spJson);
assert.equal(setMaker("GMK Salamander"), "GMK");
assert.equal(setMaker("GMK Sanctuary"), "GMK");

// Selecting both makers unions the arms rather than intersecting them.
assert.equal(makerWhereOr(["GMK", "SP"]).length, gmkOr.length + spOr.length);
assert.deepEqual(makerWhereOr([]), []);

// ── "kit" is packaging, not identity ────────────────────────────────────────
// Mirror of KitFillerTests in scraper/tests/test_scraper_helpers.py — this
// function is duplicated in Python, so both copies must agree.
assert.equal(
  normalizeSetName("DCS After School 1992 40s kit"),
  normalizeSetName("(In Stock) DCS After-School 1992 40s Keycap Set")
);
assert.equal(normalizeSetName("GMK Foo Kit"), normalizeSetName("GMK Foo"));
// `\bkits?\b` must not match inside a longer word.
assert.equal(normalizeSetName("GMK CYL Kitsune"), "gmk kitsune");
assert.equal(normalizeSetName("GMK Kitsune Keycaps"), "gmk kitsune");
assert.notEqual(normalizeSetName("DCS 9009 Fix Kit"), normalizeSetName("DCS 9009"));

// ── displaySetName ──────────────────────────────────────────────────────────
// The live row that prompted this: a real, priced, in-stock iLumKB listing
// whose NAME came from the Geekhack thread it was discovered through.
assert.equal(displaySetName("[GB] MW STONE Age (GB CLOSED)"), "MW STONE Age");
assert.equal(
  displaySetName("[GB] DCS Dolch - Live from June 1st to July 1st!"),
  "DCS Dolch - Live from June 1st to July 1st!"
);
assert.equal(displaySetName("[IC] GMK Foo"), "GMK Foo");
assert.equal(displaySetName("(Group Buy) GMK Bar"), "GMK Bar");
assert.equal(displaySetName("[GB][In Stock] GMK Baz"), "GMK Baz");
assert.equal(displaySetName("GMK Qux (GB CLOSED)"), "GMK Qux");
assert.equal(displaySetName("GMK Quux | Running Oct 17 - Nov 14"), "GMK Quux");
assert.equal(displaySetName("GMK Corge (Closed) (Shipped)"), "GMK Corge");

// Parentheticals that carry PRODUCT information must survive — this is why the
// suffix rule names status words instead of dropping every trailing bracket.
assert.equal(displaySetName("GMK Nautilus (2021)"), "GMK Nautilus (2021)");
assert.equal(displaySetName("GMK Bento (R2)"), "GMK Bento (R2)");
assert.equal(displaySetName("SA Laser (Alphas)"), "SA Laser (Alphas)");
assert.equal(displaySetName("GMK Olivia++"), "GMK Olivia++");

// A clean name is returned untouched, and a name that is nothing but tags is
// shown verbatim rather than blanked.
assert.equal(displaySetName("GMK Botanical"), "GMK Botanical");
assert.equal(displaySetName("[GB]"), "[GB]");
assert.equal(displaySetName(""), "");

// Stripping is display-only: identity helpers must be unaffected, so a
// Geekhack DCS row still resolves to Signature Plastics and never to GMK.
assert.equal(setMaker(displaySetName("[GB] DCS Mermaid")), "SP");
assert.equal(
  normalizeSetName("[GB] MW STONE Age (GB CLOSED)"),
  normalizeSetName(displaySetName("[GB] MW STONE Age (GB CLOSED)"))
);

// ── The tracked-profile gate ────────────────────────────────────────────────
// Discovery keeps only the catalog products whose title names a tracked
// profile, and that gate is the FIRST thing every store listing meets. When it
// was a local `\b(?:GMK|DCS)\b` it was narrower than the maker registry above,
// so every SA / DSS / DSA / MTNU / CYL product in every store catalog was
// dropped before matchProduct ever saw it — and a store that sells only those
// (a Signature Plastics specialist) published nothing at all while every
// storefront repair read its row as healthy.

// Every profile the site files under a maker must get through the gate.
for (const profile of TRACKED_PROFILES) {
  assert.ok(
    TRACKED_PROFILE_RE.test(`${profile} Dolch`),
    `${profile} is a tracked profile but the discovery gate refuses it`
  );
  assert.ok(setMaker(`${profile} Dolch`), `${profile} must resolve to a maker`);
}

// …and the registry must not carry a prefix the gate has never heard of. This
// is the assertion that would have failed the day "SA " was added to
// MAKER_NAME_PREFIXES while the gate stayed on GMK|DCS.
for (const prefixes of Object.values(MAKER_NAME_PREFIXES)) {
  for (const prefix of prefixes) {
    assert.ok(
      TRACKED_PROFILE_RE.test(`${prefix.trim()} Dolch`),
      `MAKER_NAME_PREFIXES lists "${prefix}" but the discovery gate refuses it — ` +
        `the site would publish those sets while no vendor could ever be linked to one`
    );
  }
}

// The real listings this went wrong on.
assert.ok(TRACKED_PROFILE_RE.test("SA Laser"));
assert.ok(TRACKED_PROFILE_RE.test("(In Stock) DSS Fjord Keycap Set"));
assert.ok(TRACKED_PROFILE_RE.test("DSA Magic Girl"));
assert.ok(TRACKED_PROFILE_RE.test("MTNU Electronic Control"));
assert.ok(TRACKED_PROFILE_RE.test("CYL Alter Redux"));

// Whole-word only. This is what lets the gate carry the two-letter tokens that
// MAKER_NAME_PREFIXES has to spell as "SA " with a trailing space: "Salamander"
// and "Sanctuary" are GMK sets and must not be read as Signature Plastics ones,
// and a profile named mid-word is not a profile.
assert.ok(!TRACKED_PROFILE_RE.test("Salamander"));
assert.ok(!TRACKED_PROFILE_RE.test("Sanctuary"));
assert.ok(!TRACKED_PROFILE_RE.test("USA Keyboards"));
assert.ok(!TRACKED_PROFILE_RE.test("PBT Heavy Industry"));
assert.ok(!TRACKED_PROFILE_RE.test("KAT Milkshake"), "KAT is not a profile we track");

// ── Agreement with the Python scraper ───────────────────────────────────────
// Discovery is written twice — run_discovery in scrape.py is the nightly that
// actually crawls, discoverGmkProducts is the Vercel cron. A gate widened on
// one side only would leave the nightly still refusing the very listings this
// exists to link, which is precisely how #131's discovery filter went half
// applied for a year.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const scraperSource = read("scraper/scrape.py");
const pyProfiles = /TRACKED_PROFILES\s*=\s*\(([^)]*)\)/.exec(scraperSource);
assert.ok(pyProfiles, "scrape.py must keep TRACKED_PROFILES");
const pyTokens: string[] = [];
const tokenRe = /"([^"]+)"/g;
let tokenMatch: RegExpExecArray | null;
while ((tokenMatch = tokenRe.exec(pyProfiles[1])) !== null) pyTokens.push(tokenMatch[1]);
assert.deepEqual(
  pyTokens,
  TRACKED_PROFILES,
  "scrape.py and set-name.ts must gate vendor catalogs on the same profiles"
);

// And the TS half must take the gate from here rather than re-declaring one —
// a local literal is how the two drifted in the first place.
const discoverySource = read("src/lib/import/discovery.ts");
assert.ok(
  /import\s*\{[^}]*TRACKED_PROFILE_RE[^}]*\}\s*from\s*"@\/lib\/set-name"/.test(discoverySource),
  "discovery.ts must import TRACKED_PROFILE_RE from set-name.ts"
);
assert.ok(
  !/const\s+TRACKED_PROFILE_RE\s*=/.test(discoverySource),
  "discovery.ts still declares its own tracked-profile regex"
);

// The tracked-profile gate is only reached for stores discovery can read a
// catalog FOR. `/products.json` is a Shopify endpoint, and about a fifth of the
// roster is not Shopify (Ashkeebs and Zion Studios are WooCommerce, CandyKeys
// serves /group-buys/…, MyKeyboard.eu /catalogue/category/…) — so both halves
// fall back to crawling the storefront's own group-buy / pre-order / in-stock
// pages. The nightly is the half that can actually fetch them, and it spent a
// year without the fallback: none of those stores ever had a listing linked or
// relinked, their rows stayed frozen on whatever the first import wrote, and
// every one of them read as "discovery has never matched a tracked set" in
// db-setup's silent-vendor report. Assert the nightly still has the path, and
// that both halves choose section pages by the same rule.
assert.ok(
  /def\s+html_catalog\s*\(/.test(scraperSource),
  "scrape.py must keep the non-Shopify HTML catalog fallback"
);
assert.ok(
  /catalog\s*=\s*html_catalog\(/.test(scraperSource),
  "run_discovery must fall back to html_catalog when /products.json is unreadable"
);
const tsSection = /const\s+SECTION_LINK_RE\s*=\s*\/([^/]+)\/i;/.exec(discoverySource);
const pySection = /_DISCOVERY_SECTION_RE\s*=\s*re\.compile\(\s*\n?\s*r"([^"]+)"/.exec(
  scraperSource
);
assert.ok(tsSection, "discovery.ts must keep SECTION_LINK_RE");
assert.ok(pySection, "scrape.py must keep _DISCOVERY_SECTION_RE");
assert.equal(
  pySection[1],
  tsSection[1],
  "scrape.py and discovery.ts must pick catalog section pages by the same rule"
);

console.log("set-name profile-identity checks passed");
