import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  buildPhotoAt,
  photoFingerprint,
  publicPurchaseIndexes,
  storedIndexForPublicPosition,
  buildPosterModel,
  hiddenBuildSet,
  isPieceDisplayed,
  posterItemImage,
  posterVersion,
  visibleBuildIndexes,
  type PosterSourceItem,
} from "./public-collection";

const gb = (productType: string, name = "Board") => ({
  name,
  designer: "TGR",
  imageUrl: "catalog.jpg",
  productType,
  layout: "TKL",
  vendorName: null,
});
const keyboard = (patch: Partial<PosterSourceItem>): PosterSourceItem => ({
  customImageUrl: null,
  quantity: 1,
  hiddenBuilds: [],
  units: [],
  keycapAcquisitions: null,
  groupBuy: gb("KEYBOARD"),
  ...patch,
});
const keycaps = (patch: Partial<PosterSourceItem>): PosterSourceItem => ({
  ...keyboard({}),
  groupBuy: gb("KEYCAPS", "GMK Set"),
  ...patch,
});

// ── visible builds ──────────────────────────────────────────────────────────
assert.deepEqual(visibleBuildIndexes(3, [0]), [1, 2]);
assert.deepEqual(visibleBuildIndexes(2, [0, 1]), []);
assert.deepEqual(visibleBuildIndexes(null, null), [0], "a record always has build 1");
assert.deepEqual(Array.from(hiddenBuildSet(["1", 2, "x"])), [1, 2], "junk entries are ignored");
assert.equal(buildPhotoAt("b1.jpg", [{ imageUrl: "b2.jpg" }], 0), "b1.jpg");
assert.equal(buildPhotoAt("b1.jpg", [{ imageUrl: "b2.jpg" }], 1), "b2.jpg");
assert.equal(buildPhotoAt("b1.jpg", [], 1), null);

// ── public positions → stored records (the photo-report endpoint) ───────────
// The browser only ever sees public positions; the server maps them back.
assert.deepEqual(publicPurchaseIndexes([{ isPublic: false }, { isPublic: false }, {}]), [2]);
assert.deepEqual(publicPurchaseIndexes(null), [0], "a legacy set is its one synthesised purchase");
assert.deepEqual(publicPurchaseIndexes([]), [0]);
const kb = { productType: "KEYBOARD", quantity: 3, hiddenBuilds: [0], keycapAcquisitions: null };
assert.equal(storedIndexForPublicPosition(kb, 0), 1, "public 'Build 1' is stored build 2 when build 1 is hidden");
assert.equal(storedIndexForPublicPosition(kb, 1), 2);
assert.equal(storedIndexForPublicPosition(kb, 2), null, "no third public build");
assert.equal(storedIndexForPublicPosition(kb, -1), null);
const kc = { productType: "KEYCAPS", quantity: 1, hiddenBuilds: null, keycapAcquisitions: [{ isPublic: false }, {}, { isPublic: false }, {}] };
assert.equal(storedIndexForPublicPosition(kc, 0), 1);
assert.equal(storedIndexForPublicPosition(kc, 1), 3);
assert.equal(storedIndexForPublicPosition(kc, 2), null, "a private purchase has no public position");

// A report carries the fingerprint of the photo the visitor SAW, computed
// exactly as the endpoint hashes the stored photo (trimmed sha256).
assert.equal(
  photoFingerprint("  data:image/png;base64,AAAA  "),
  createHash("sha256").update("data:image/png;base64,AAAA").digest("hex")
);

// ── the share poster never draws a hidden build's photo ─────────────────────
const hiddenB1 = keyboard({
  quantity: 2,
  hiddenBuilds: [0],
  customImageUrl: "HIDDEN-BUILD-1.jpg",
  units: [{ imageUrl: "VISIBLE-BUILD-2.jpg" }],
});
assert.equal(posterItemImage(hiddenB1), "VISIBLE-BUILD-2.jpg");
assert.equal(
  posterItemImage({ ...hiddenB1, units: [{}] }),
  "catalog.jpg",
  "a hidden build 1's photo is never the fallback"
);
assert.equal(posterItemImage(keyboard({ customImageUrl: "b1.jpg" })), "b1.jpg");
assert.equal(isPieceDisplayed(keyboard({ quantity: 2, hiddenBuilds: [0, 1] })), false);

// ── nor a private (or replaced) keycap photo ────────────────────────────────
const privateLegacy = keycaps({
  customImageUrl: "OLD-TOP-LEVEL.jpg",
  keycapAcquisitions: [
    { isPublic: false, photoSource: "CUSTOM", imageUrl: "PRIVATE.jpg" },
    { isPublic: true, photoSource: "CATALOG", imageUrl: null },
  ],
});
assert.equal(posterItemImage(privateLegacy), "catalog.jpg", "never the legacy column once purchases exist");
assert.equal(
  posterItemImage(
    keycaps({
      keycapAcquisitions: [
        { isPublic: false, photoSource: "CUSTOM", imageUrl: "PRIVATE.jpg" },
        { isPublic: true, photoSource: "CUSTOM", imageUrl: "PUBLIC.jpg" },
      ],
    })
  ),
  "PUBLIC.jpg"
);
assert.equal(posterItemImage(keycaps({ customImageUrl: "legacy.jpg", keycapAcquisitions: [] })), "legacy.jpg", "a set that never had purchases still reads it");
assert.equal(isPieceDisplayed(keycaps({ keycapAcquisitions: [{ isPublic: false }] })), false);

// ── the poster model: counts and images from public pieces only ─────────────
const model = buildPosterModel({
  displayName: "Ryan",
  collectionTitle: null,
  collectionBio: null,
  items: [hiddenB1, keyboard({ quantity: 2, hiddenBuilds: [0, 1], customImageUrl: "ALL-HIDDEN.jpg" }), privateLegacy],
});
assert.equal(model.displayed, 2, "a fully hidden keyboard is not counted");
assert.equal(model.keyboards, 1);
assert.deepEqual(model.imageUrls, ["VISIBLE-BUILD-2.jpg", "catalog.jpg"]);
assert.ok(!JSON.stringify(model).includes("HIDDEN"), "no hidden photo anywhere in the model");
assert.ok(!JSON.stringify(model).includes("PRIVATE"));

// ── the cache token: changes with the picture, never with private data ──────
const base = { displayName: "Ryan", collectionTitle: "Desk", collectionBio: null, items: [hiddenB1] };
const v1 = posterVersion(buildPosterModel(base));
assert.match(v1, /^[0-9a-f]{16}$/);
assert.equal(posterVersion(buildPosterModel(base)), v1, "deterministic");
assert.equal(
  posterVersion(buildPosterModel({ ...base, items: [{ ...hiddenB1, customImageUrl: "NEW-HIDDEN.jpg" }] })),
  v1,
  "editing a hidden build's photo changes nothing public, so it must not move the token"
);
assert.notEqual(posterVersion(buildPosterModel({ ...base, collectionTitle: "Desk 2" })), v1);
assert.notEqual(
  posterVersion(buildPosterModel({ ...base, items: [{ ...hiddenB1, hiddenBuilds: [] }] })),
  v1,
  "un-hiding build 1 changes the picture, so the token moves"
);

// ── every public surface asks these helpers ─────────────────────────────────
const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const page = read("src/app/collection/[slug]/page.tsx");
const poster = read("src/app/api/collection-poster/[slug]/route.tsx");
const reports = read("src/app/api/collection-photo-reports/route.ts");
assert.match(page, /posterVersion\(buildPosterModel\(collection\)\)/, "the og:image token is the poster model's hash");
assert.doesNotMatch(page, /updatedAt\.getTime\(\)/, "no activity timestamp in a public URL");
assert.match(page, /const solo = multiBuild \? null : builds\[0\]\.build;/, "the single-build card reads the visible build");
assert.doesNotMatch(page, /\{item\.(switches|keycaps|plateType|mountType|pcbType|layoutVariant|color|buildDetails) &&/, "the card never renders build 1's top-level columns directly");
// Nothing but public positions reaches the browser (props of client components
// are serialized into the page's flight data).
assert.doesNotMatch(page, /buildIndex: (originalIndex|purchase\.rawIndex)/, "no stored index in a slide");
assert.doesNotMatch(page, /key=\{originalIndex\}|buildIndex=\{index\}/, "no stored index as a key or report target");
assert.match(page, /buildIndex: position,/);
assert.match(reports, /storedIndexForPublicPosition\(/, "the report endpoint maps public positions on the server");
assert.match(reports, /if \(imageHash !== seenPhotoHash\)/, "a report can only land on the photo the visitor saw");
assert.match(reports, /!\/\^\[0-9a-f\]\{64\}\$\/\.test\(seenPhotoHash\)/, "and must carry its fingerprint");
assert.match(page, /photoHash: build\.imageUrl \? photoFingerprint\(build\.imageUrl\) : null/);
assert.match(page, /photoHash=\{photoFingerprint\(build\.imageUrl\)\}/);
assert.match(read("src/components/collection/CollectionCardGallery.tsx"), /photoHash=\{current\.photoHash\}/);
assert.match(read("src/components/collection/ReportPhotoButton.tsx"), /buildIndex,\s*photoHash,/);
assert.match(page, /buildLabel\(build, position\)/, "unnamed public builds are numbered among visible builds");
assert.match(poster, /buildPosterModel\(collection\)/);
assert.doesNotMatch(poster, /function posterItemImage/, "the poster has no image rule of its own");
assert.match(poster, /units: true/);
assert.doesNotMatch(reports, /const buildIndex = Number\(body/, "the client's number is a public position, not a stored index");
for (const path of ["src/app/api/poster/[slug]/route.tsx", "src/app/share/[slug]/page.tsx", "src/app/api/group-buys/[slug]/route.ts"]) {
  assert.match(read(path), /isHiddenSlug\(slug\) \|\| isCustomSlug\(slug\)/, `${path} refuses pulled and custom slugs`);
}

// ── caching: the poster is cached only under its own content's version ──────
assert.match(poster, /requestedVersion === posterVersion\(model\)/, "a mismatched ?v is never cached");
assert.match(poster, /"cache-control": cacheable/, "lowercase, so it REPLACES ImageResponse's immutable default");
assert.doesNotMatch(poster, /"Cache-Control":/);
assert.doesNotMatch(read("src/app/api/poster/[slug]/route.tsx"), /"Cache-Control":/, "same header trap on the set poster");

// ── writers that could publish or destroy someone's private data ────────────
const commit = read("src/app/api/tracker/items/import/commit/route.ts");
assert.match(
  commit,
  /isPublic: existing\?\.inCollection && !created \? existing\.isPublic && isPublic : isPublic/,
  "CSV import never makes a set already in the collection public — but a custom piece it just created follows the batch"
);
const trackerData = read("src/lib/tracker-data.ts");
assert.match(trackerData, /export function notSomeoneElsesCustomPiece/);
assert.match(trackerData, /export function attachableGroupBuyWhere[\s\S]*notSomeoneElsesCustomPiece\(userId\)[\s\S]*notIn: HIDDEN_SLUGS/);
for (const [path, pattern] of [
  ["src/lib/tracker-data.ts", /where: \{ slug, \.\.\.attachableGroupBuyWhere\(userId\) \}/],
  ["src/lib/tracker-data.ts", /slug: \{ in: normalizedSlugs \}, \.\.\.attachableGroupBuyWhere\(userId\)/],
  ["src/app/api/tracker/items/route.ts", /getGroupBuyForTracking\(slug, user\.id\)/],
  ["src/app/api/tracker/items/import/commit/route.ts", /\.\.\.attachableGroupBuyWhere\(user\.id\)/],
] as const) {
  assert.match(read(path), pattern, `${path}: no attaching to another user's custom piece`);
}
const itemRoute = read("src/app/api/tracker/items/[slug]/route.ts");
assert.match(itemRoute, /if \(othersHoldingIt === 0\) \{\s*await prisma\.groupBuy\.delete/, "a custom piece's GroupBuy is deleted only when nobody else holds it");
assert.doesNotMatch(read("scripts/visitor-inbox-ci.mjs"), /maskEmail|r\.email/, "no visitor email in public Actions logs");

// The import matcher composes its slug filters with AND — two spreads that
// both set `slug` silently dropped the custom-piece exclusion.
const resolve = read("src/app/api/tracker/items/import/resolve/route.ts");
assert.doesNotMatch(resolve, /\.\.\.notCustomWhere,\s*\.\.\.\(HIDDEN_SLUGS/, "no second spread overwriting the first");
assert.match(resolve, /AND: \[/);
assert.match(resolve, /trackerItems: \{ some: \{ userId: user\.id \} \}/, "only the importer's OWN custom pieces are matchable");

// A privacy-pulled board never reaches a public collection surface.
for (const path of ["src/app/collection/[slug]/page.tsx", "src/app/api/collection-poster/[slug]/route.tsx", "src/app/api/collection-photo-reports/route.ts"]) {
  assert.match(read(path), /groupBuy: \{ slug: \{ notIn: HIDDEN_SLUGS \} \}/, `${path} excludes HIDDEN_SLUGS`);
}

console.log("public collection privacy checks passed");
