// Every field the collection editor can WRITE must come back when it READS.
//
// A keyboard's sale was saved, stored correctly, and gone after a refresh.
// `/api/tracker/items/[slug]` PATCH accepted `isSold`, `soldAt`, `soldPrice`,
// `soldCurrency` and `showSoldStatus` and wrote all five; `/api/tracker` — the
// only endpoint the owner's own collection page reads — returned none of them.
// The PUBLIC page has its own Prisma select and did list them, so the sale
// showed to visitors and not to the owner.
//
// The damage was not the missing badge. The editor seeds its build list from
// this payload (`assembleBuilds(item.collection)`), so build 1 opened unsold
// with an empty sale, and the next save of that piece sent isSold:false,
// soldAt:null, soldPrice:null — writing over a sale the owner had recorded.
// A field that is writable but not readable does not go stale; it gets erased
// on the next edit.
//
// Nothing could catch it: every one of those fields is OPTIONAL on
// `CollectionItemDetails`, so leaving them out of the response typechecks, and
// no suite compared the two halves. This is that comparison. It reads both
// route files as text — like manufacturer-vendors and link-health read
// scrape.py — because the two sides share no module to assert against.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const PATCH_ROUTE = "src/app/api/tracker/items/[slug]/route.ts";
const LIST_ROUTE = "src/app/api/tracker/route.ts";

const patchSource = read(PATCH_ROUTE);
const listSource = read(LIST_ROUTE);

// Top-level TrackerItem columns the PATCH assigns. `data.X = …` is how every
// one of them is written, including the reset branch for un-collecting.
const written = new Set([...patchSource.matchAll(/\bdata\.([A-Za-z_]\w*)\s*=/g)].map((m) => m[1]));
assert.ok(written.size > 10, "the PATCH sanitizer should write many fields; the scrape found almost none");

// The `collection` object the list endpoint hands the owner's page.
const start = listSource.indexOf("collection: {");
assert.ok(start > -1, `${LIST_ROUTE} must build a collection object`);
const end = listSource.indexOf("})),", start);
assert.ok(end > start, "could not find the end of the collection object");
const returned = new Set(
  [...listSource.slice(start, end).matchAll(/^\s*([A-Za-z_]\w*):/gm)].map((m) => m[1])
);

const missing = [...written].filter((field) => !returned.has(field)).sort();
assert.deepEqual(
  missing,
  [],
  `${LIST_ROUTE} must return every field the editor can write, or the next save ` +
    `overwrites it with a blank. Missing: ${missing.join(", ")}`
);

// The five that were actually lost, named outright: a future refactor of the
// scrape above must not quietly stop covering them.
for (const field of ["isSold", "soldAt", "soldPrice", "soldCurrency", "showSoldStatus"]) {
  assert.ok(written.has(field), `the PATCH must still accept ${field}`);
  assert.ok(returned.has(field), `${LIST_ROUTE} must return ${field}`);
}

// Build 1's sale lives on the top-level columns while builds 2..N carry theirs
// inside `units`, which is why only build 1 was affected — and why `units`
// has to keep coming back too.
assert.ok(returned.has("units"), "builds 2..N would vanish without this");
assert.ok(returned.has("keycapAcquisitions"), "keycap purchases carry their own sales");

// The omission typechecked because the type makes them optional. If that ever
// changes to required, this note should go — but until then the suite is the
// only thing standing between a writable field and a silent erase.
const types = read("src/types/index.ts");
assert.ok(
  /isSold\?: boolean;/.test(types),
  "CollectionItemDetails still marks the sale fields optional — this suite is the guard"
);

console.log("collection round-trip checks passed");
