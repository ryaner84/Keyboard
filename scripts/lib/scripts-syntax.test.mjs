// Does every script in scripts/ still PARSE?
//
// A trivial question that nothing asked, and it cost a deploy. `npm run build`
// is `prisma generate && node scripts/db-setup.mjs && next build`, so a
// db-setup.mjs that cannot be parsed fails the build before `next build` is
// reached — the site stays on its previous deployment and every fix in the
// commit reaches nobody.
//
// Nothing in the gate could see it. A dozen suites read db-setup.mjs as TEXT
// (vendor-urls, kit-bounds, manufacturer-vendors, keyboard-vendors,
// currencies) and assert on its literal contents; not one of them IMPORTS it,
// and it is imported by no other module, so a syntax error is invisible to
// them. `tsc --noEmit` only includes **/*.ts, and `next lint` does not reach
// scripts/. All 19 suites, the typecheck and the lint passed on a file Node
// refused to read.
//
// The specific mistake is worth naming, because the shape recurs all over this
// directory: db-setup builds its SQL as JS TEMPLATE LITERALS, and a SQL comment
// written inside one used BACKTICKS to quote an expression the way the rest of
// this codebase's prose does. The backtick ended the template string, and
// everything after it was parsed as JavaScript:
//
//   -- currency is the half that matters: `currency = currency or
//   -- vendor_currency` is the fallback in BOTH price passes
//
//   SyntaxError: missing ) after argument list
//
// So: parse every .mjs under scripts/, including this file's neighbours and the
// deploy entry point itself. `node --check` is exactly the question — it parses
// and does not execute, so a script with database side effects is safe to
// check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

function mjsFilesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...mjsFilesUnder(full));
    } else if (entry.name.endsWith(".mjs")) {
      found.push(full);
    }
  }
  return found;
}

const files = mjsFilesUnder(SCRIPTS_DIR).sort();
assert.ok(files.length >= 20, `found the scripts to check (${files.length})`);

const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failures.push(`${relative(REPO_ROOT, file)}\n${err.stderr?.toString() ?? err.message}`);
  }
}
assert.deepEqual(failures, [], `every script in scripts/ must parse:\n\n${failures.join("\n")}`);

// The deploy entry point by name, so the assertion above can never pass by
// finding nothing: `npm run build` runs THIS file, and it is the one whose
// failure takes the whole site's next deployment with it.
const dbSetup = join(SCRIPTS_DIR, "db-setup.mjs");
assert.ok(files.includes(dbSetup), "db-setup.mjs — the build's own script — is among the files checked");

console.log(`scripts-syntax: ${files.length} script(s) parse`);
