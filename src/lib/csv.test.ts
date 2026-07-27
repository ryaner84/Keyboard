import assert from "node:assert/strict";
import {
  buildKeycapTemplateCsv,
  parseCsv,
  parseKeycapImportCsv,
} from "@/lib/csv";

// --- parseCsv -------------------------------------------------------------

// Quoted commas must stay inside one cell, "" is a literal quote.
assert.deepEqual(parseCsv('a,"b,c",d'), [["a", "b,c", "d"]]);
assert.deepEqual(parseCsv('a,"she said ""hi""",c'), [["a", 'she said "hi"', "c"]]);

// CRLF, lone CR and LF all end a row; a trailing newline adds no empty row.
assert.deepEqual(parseCsv("a,b\r\nc,d\r\n"), [["a", "b"], ["c", "d"]]);
assert.deepEqual(parseCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]]);

// A UTF-8 BOM (Excel writes one) must not poison the first header cell.
assert.deepEqual(parseCsv("﻿name,kits\nGMK Bento,Base"), [
  ["name", "kits"],
  ["GMK Bento", "Base"],
]);

// Blank lines are dropped; embedded newlines inside quotes are preserved.
assert.deepEqual(parseCsv("a,b\n\n\nc,d"), [["a", "b"], ["c", "d"]]);
assert.deepEqual(parseCsv('a,"line1\nline2"'), [["a", "line1\nline2"]]);

// Ragged rows are returned as-is (missing cells simply absent).
assert.deepEqual(parseCsv("a,b,c\n1,2"), [["a", "b", "c"], ["1", "2"]]);

// --- header mapping -------------------------------------------------------

// Reordered + differently-spelled headers still map; unknown columns ignored.
const reordered = parseKeycapImportCsv(
  "Qty,Set Name,Acquired Date,Colour\n2,GMK Bento,2024-01-05,blue"
);
assert.equal(reordered.fileErrors.length, 0);
assert.equal(reordered.rows.length, 1);
assert.equal(reordered.rows[0].name, "GMK Bento");
assert.equal(reordered.rows[0].quantity, 2);
assert.equal(reordered.rows[0].acquiredAt, new Date(Date.UTC(2024, 0, 5)).toISOString());

// A file with no name column is rejected outright.
const noName = parseKeycapImportCsv("kits,price\nBase,100");
assert.equal(noName.rows.length, 0);
assert.match(noName.fileErrors[0], /name/i);

// Empty file.
assert.equal(parseKeycapImportCsv("").fileErrors.length, 1);

// --- row mapping + defaults ----------------------------------------------

const parsed = parseKeycapImportCsv(
  [
    "name,kits,quantity,acquired_date,price,currency,condition,notes",
    'GMK Olivia R2,"Base, Novelties",2,2024-03-15,145,USD,SEALED,Nice',
    "GMK Botanical,,,,,,,", // name only -> all defaults
  ].join("\n")
);
assert.equal(parsed.rows.length, 2);

const full = parsed.rows[0];
assert.equal(full.line, 2); // header is line 1
assert.deepEqual(full.kits, ["Base", "Novelties"]);
assert.equal(full.quantity, 2);
assert.equal(full.price, 145);
assert.equal(full.currency, "USD");
assert.equal(full.condition, "SEALED");
assert.equal(full.notes, "Nice");
assert.deepEqual(full.errors, []);

const bare = parsed.rows[1];
assert.equal(bare.name, "GMK Botanical");
assert.deepEqual(bare.kits, []);
assert.equal(bare.quantity, 1); // default
assert.equal(bare.acquiredAt, null);
assert.equal(bare.price, null);
assert.equal(bare.currency, null);
assert.equal(bare.condition, null);
assert.deepEqual(bare.errors, []); // name-only is perfectly valid

// --- invalid values are REPORTED, not silently dropped --------------------

const bad = parseKeycapImportCsv(
  [
    "name,quantity,acquired_date,price,currency,condition",
    "GMK A,0,2024-03-15,10,USD,SEALED", // quantity out of range
    "GMK B,1,03/04/2024,10,USD,SEALED", // ambiguous date
    "GMK C,1,2024-03-15,-5,USD,SEALED", // negative price
    "GMK D,1,2024-03-15,10,XYZ,SEALED", // unknown currency
    "GMK E,1,2024-03-15,10,USD,MINT", // unknown condition
    ",1,2024-03-15,10,USD,SEALED", // missing name
  ].join("\n")
);
assert.match(bad.rows[0].errors[0], /Quantity/);
assert.match(bad.rows[1].errors[0], /Ambiguous/);
assert.match(bad.rows[2].errors[0], /price/i);
assert.match(bad.rows[3].errors[0], /currency/i);
assert.match(bad.rows[4].errors[0], /condition/i);
assert.match(bad.rows[5].errors[0], /Missing set name/);
// A reported row is still returned so the review table can show it.
assert.equal(bad.rows.length, 6);

// Unambiguous slash dates resolve; day>12 pins it to D/M/Y.
const slash = parseKeycapImportCsv("name,acquired_date\nGMK A,15/03/2024");
assert.deepEqual(slash.rows[0].errors, []);
assert.equal(slash.rows[0].acquiredAt, new Date(Date.UTC(2024, 2, 15)).toISOString());

// Spreadsheet-mangled money: symbols and thousands separators.
const money = parseKeycapImportCsv(
  ['name,price', '"GMK A","S$1,234.50"', '"GMK B","€130"'].join("\n")
);
assert.equal(money.rows[0].price, 1234.5);
assert.equal(money.rows[1].price, 130);

// Human condition labels from the UI are accepted, not just the codes.
const label = parseKeycapImportCsv("name,condition\nGMK A,Opened / unused");
assert.equal(label.rows[0].condition, "OPEN_UNUSED");
assert.deepEqual(label.rows[0].errors, []);

// Kits dedupe and cap at 12.
const kits = parseKeycapImportCsv('name,kits\nGMK A,"Base, Base, Novelties"');
assert.deepEqual(kits.rows[0].kits, ["Base", "Novelties"]);

// --- template round-trips through the parser ------------------------------

const template = parseKeycapImportCsv(buildKeycapTemplateCsv());
assert.equal(template.fileErrors.length, 0);
assert.equal(template.rows.length, 3);
assert.ok(template.rows.every((row) => row.errors.length === 0));
assert.equal(template.rows[0].name, "GMK Olivia R2");
assert.deepEqual(template.rows[0].kits, ["Base", "Novelties"]);

console.log("csv import parser checks passed");
