import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

import {
  INCOMPLETE_CHAIN_ERROR_MARKERS,
  caIssuerUrls,
  clearChainRepairs,
  derToPem,
  isIncompleteChainError,
  issuedByTrustedRoot,
  repairedChainHosts,
  retryWithRepairedChain,
} from "./tls-chain.mjs";
import {
  GONE_HOST_ERROR_MARKERS,
  UNRESOLVED_HOST_ERROR_MARKERS,
} from "./link-health.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── The reported case, verbatim from a GitHub runner ────────────────────────
// scripts/vendor-link-probe.mjs against the two vendors the publishing audit
// named on 2026-09-11 and again on 2026-09-12:
//
//   === PROBE https://auramech.com/products/gmk-evil-dolch
//     RESULT    | UNREACHABLE — fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
//   === PROBE https://hineybush.com/products/gmk-og-spacekeys-r2
//     RESULT    | UNREACHABLE — fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
//
// Both hosts resolve, both accept the connection, both serve browsers. Their
// servers simply do not send the intermediate certificate, and Node — unlike
// every browser — will not fetch it. The price pass filed that under the same
// null a Cloudflare block gives, so `priceSource` stayed NULL, `linkFailures`
// climbed on a store that answers, and the publishing report reached its "every
// attempt ended with no answer at all, which is what a BLOCK looks like from
// here" sentence about a host that answers perfectly well.
assert.equal(
  isIncompleteChainError(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("unable to get local issuer certificate"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      }),
    })
  ),
  true,
  "the shape fetch() actually throws — the code is buried in `cause`, never on the error itself"
);

// The same misconfiguration reported from the other side: a presented chain
// that stops short of anything in the store.
assert.equal(
  isIncompleteChainError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
  true,
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE is the same missing intermediate"
);

// AggregateError is how a happy-eyeballs failure arrives, and the chain error
// can be one of its members rather than the error itself.
assert.equal(
  isIncompleteChainError(
    Object.assign(new TypeError("fetch failed"), {
      cause: new AggregateError([{ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }], "all failed"),
    })
  ),
  true,
  "a chain failure nested inside an AggregateError still counts"
);

assert.equal(isIncompleteChainError(null), false, "a missing error is not a chain failure");
assert.equal(
  isIncompleteChainError({ cause: { cause: { cause: null } } }),
  false,
  "walking a cause chain that names nothing terminates rather than throwing"
);

// ── Everything that is NOT this, because the repair must never fire on it ───
// Each of these is a live host, a dead name, or a certificate that is genuinely
// wrong, and none of them is repairable by fetching an issuer. Firing here
// would spend a TLS connection and a download per host learning that again,
// inside a twelve-minute run budget — the exact cost isUnresolvedHostError was
// added to stop paying for dead domains.
for (const code of [
  "ENOTFOUND", // the domain is gone — isGoneHostError's DEAD_LINK
  "EAI_AGAIN", // a temporary resolver failure — a block, never a retirement
  "ECONNREFUSED", // a host that exists and refuses
  "ECONNRESET",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED", // a live site with a lapsed certificate
  "ERR_TLS_CERT_ALTNAME_INVALID", // a live site on the wrong name
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE", // rectangles.store, same morning
]) {
  assert.equal(
    isIncompleteChainError({ code }),
    false,
    `${code} is not an incomplete chain and must not trigger a repair`
  );
}

// The two verdicts must stay disjoint in BOTH directions. `deadSince` is the
// only signal allowed to take a listing off the site, and a store whose chain
// is merely under-sent has said nothing about whether its pages exist; equally,
// a domain that no longer resolves has no certificate to repair. An overlap
// would let one answer be reached through the other's evidence.
for (const marker of INCOMPLETE_CHAIN_ERROR_MARKERS) {
  assert.equal(
    GONE_HOST_ERROR_MARKERS.includes(marker),
    false,
    `${marker} must never also mean the host is gone — see scripts/lib/link-health.mjs`
  );
  assert.equal(
    UNRESOLVED_HOST_ERROR_MARKERS.includes(marker),
    false,
    `${marker} must never also mean the name did not resolve`
  );
}
for (const marker of [...GONE_HOST_ERROR_MARKERS, ...UNRESOLVED_HOST_ERROR_MARKERS]) {
  assert.equal(
    isIncompleteChainError({ code: marker }),
    false,
    `${marker} is a name failure, not a chain this module can complete`
  );
}

// ── Reading the AIA extension ───────────────────────────────────────────────
// Node renders the extension as `label:value` lines, and the values are
// themselves URLs containing a colon — so the split has to be on the FIRST one.
// OCSP lines sit in the same block and are responders, not certificates: taking
// one would spend the repair's single download on something that can never
// complete a chain.
assert.deepEqual(
  caIssuerUrls(
    "OCSP - URI:http://ocsp.example.com\n" +
      "CA Issuers - URI:http://crt.example.com/intermediate.crt\n"
  ),
  ["http://crt.example.com/intermediate.crt"],
  "only CA Issuers lines are certificates, and the URL keeps its own colon"
);
assert.deepEqual(
  caIssuerUrls("OCSP - URI:http://ocsp.example.com"),
  [],
  "a certificate that names only a responder offers nothing to fetch"
);
assert.deepEqual(
  caIssuerUrls("CA Issuers - URI:ldap://directory.example.com/cn=CA"),
  [],
  "a scheme this module cannot fetch is not offered as a candidate"
);
assert.deepEqual(caIssuerUrls(undefined), [], "a certificate with no AIA extension at all");

// ── DER → PEM ───────────────────────────────────────────────────────────────
// AIA almost always serves DER, and OpenSSL only takes PEM. A round trip
// through X509Certificate is the real test: the bytes back out have to be the
// bytes that went in, or the repaired bundle would contain a different
// certificate from the one that was verified.
const workDir = mkdtempSync(join(tmpdir(), "tls-chain-test-"));
const selfSignedPem = join(workDir, "self-signed.pem");
const selfSignedKey = join(workDir, "self-signed.key");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", selfSignedKey,
  "-out", selfSignedPem,
  "-days", "1",
  "-subj", "/CN=not-a-real-ca.example",
], { stdio: "pipe" });

const selfSigned = new X509Certificate(readFileSync(selfSignedPem, "utf8"));
const rebuilt = new X509Certificate(derToPem(selfSigned.raw));
assert.deepEqual(
  Buffer.from(rebuilt.raw),
  Buffer.from(selfSigned.raw),
  "DER wrapped as PEM and parsed back is byte-for-byte the same certificate"
);
const pem = derToPem(selfSigned.raw);
assert.match(pem, /^-----BEGIN CERTIFICATE-----\n/, "PEM needs its header on its own line");
assert.match(pem, /\n-----END CERTIFICATE-----\n$/, "and its footer");
assert.ok(
  pem
    .split("\n")
    .slice(1, -2)
    .every((line) => line.length <= 64),
  "PEM base64 is wrapped at 64 columns, which OpenSSL requires"
);

// ── The safety property, which is the whole of this module ──────────────────
// A fetched intermediate handed to OpenSSL as `ca` becomes a TRUST ANCHOR. If
// the repair accepted one on the strength of the AIA pointer alone, anyone able
// to intercept the connection could serve their own leaf, point its AIA at
// their own "intermediate", and be believed — a downgrade far worse than the
// unread listing this module exists to fix. So every fetched certificate is
// checked against the real root store first, and a self-signed certificate
// nobody trusts is exactly the shape that attack produces.
assert.equal(
  issuedByTrustedRoot(selfSigned),
  false,
  "a self-signed certificate is not issued by any trusted root and may never be used as one"
);

// The positive half, from data the runtime ships: a trusted root IS self-issued
// and IS in the store, so it must pass the same test the attacker's certificate
// failed. Without this the assertion above would also hold for a function that
// always returned false, and the repair would silently never work.
const aRealRoot = rootCertificates
  .map((p) => {
    try {
      return new X509Certificate(p);
    } catch {
      return null;
    }
  })
  .find((c) => c && c.checkIssued(c));
assert.ok(aRealRoot, "the runtime ships at least one parseable self-issued root");
assert.equal(
  issuedByTrustedRoot(aRealRoot),
  true,
  "a certificate genuinely issued by a shipped root is accepted"
);

// ── The retry answers for nothing but its own failure ───────────────────────
// Every other transport error has to reach exactly the verdict it reached
// before this module existed, or a fix for one failure mode has quietly changed
// another's answer — which is how the back-off came to outlive the code that
// caused it (#165).
const notAChain = Object.assign(new TypeError("fetch failed"), {
  cause: { code: "ENOTFOUND" },
});
await assert.rejects(
  () => retryWithRepairedChain("https://example.invalid/x", notAChain),
  (err) => err === notAChain,
  "a non-chain error is rethrown unchanged, as the very same object"
);

// A host that cannot be repaired — nothing resolves here, so there is no
// certificate to read — must also leave the original error alone rather than
// replacing it with one about the repair.
const aChain = Object.assign(new TypeError("fetch failed"), {
  cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
});
await assert.rejects(
  () => retryWithRepairedChain("https://no-such-host.invalid/x", aChain),
  (err) => err === aChain,
  "an unrepairable host keeps the error the row already had"
);

// ── Per run, never across runs ──────────────────────────────────────────────
// Same rule as hostResolution: a store that fixes its chain has to be read
// normally on the next run rather than keeping a repair it no longer needs.
clearChainRepairs();
assert.deepEqual(repairedChainHosts(), [], "clearChainRepairs empties the memo");

// ── Both call sites, so the repair cannot be dropped from the half that runs ─
const pricesTs = readFileSync(join(REPO_ROOT, "src", "lib", "import", "prices.ts"), "utf8");
assert.ok(
  /isIncompleteChainError/.test(pricesTs) && /retryWithRepairedChain/.test(pricesTs),
  "prices.ts — the half that runs four times a day — must still attempt the repair"
);
assert.ok(
  /clearChainRepairs\(\)/.test(pricesTs),
  "refreshPrices must clear the repair memo per run, like hostResolution"
);
// The retry needs a timeout of its OWN. FETCH_TIMEOUT_MS is 6s and the original
// signal is already most of the way through it by the time the handshake has
// failed, so reusing it would abort the repaired request before it could
// answer — the same trap as a DNS failure taking longer than the fetch timeout
// (#168).
assert.ok(
  /isIncompleteChainError\(err\)\)[\s\S]{0,400}?new AbortController\(\)/.test(pricesTs),
  "the repaired retry must run on a fresh timeout, not the exhausted one"
);
const probe = readFileSync(join(REPO_ROOT, "scripts", "vendor-link-probe.mjs"), "utf8");
assert.ok(
  /isIncompleteChainError/.test(probe) && /retryWithRepairedChain/.test(probe),
  "the probe must reach the same verdict as the price pass on the same response"
);

console.log("tls-chain tests passed");
