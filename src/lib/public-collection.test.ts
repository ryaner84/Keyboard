import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPhotoAt,
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
assert.match(page, /buildIndex: purchase\.rawIndex/, "keycap photo reports use the stored index");
assert.match(page, /buildLabel\(build, position\)/, "unnamed public builds are numbered among visible builds");
assert.match(poster, /buildPosterModel\(collection\)/);
assert.doesNotMatch(poster, /function posterItemImage/, "the poster has no image rule of its own");
assert.match(poster, /units: true/);
assert.match(reports, /visibleBuildIndexes\(item\.quantity, item\.hiddenBuilds\)/, "a hidden build's photo cannot be probed or reported");
for (const path of ["src/app/api/poster/[slug]/route.tsx", "src/app/share/[slug]/page.tsx", "src/app/api/group-buys/[slug]/route.ts"]) {
  assert.match(read(path), /isHiddenSlug\(slug\) \|\| isCustomSlug\(slug\)/, `${path} refuses pulled and custom slugs`);
}

console.log("public collection privacy checks passed");
