// A live store whose server forgets to send its intermediate certificate, and
// the one place that is repaired.
//
// TLS requires the SERVER to send every certificate between its own and a
// trusted root. A misconfigured one sends only its own, and the verifier is
// then asked to complete a chain it was never given. Browsers complete it
// themselves: the leaf certificate carries an "Authority Information Access"
// extension naming the URL of its issuer, and Chrome (and Safari, and every
// platform verifier) fetches it. Node does not — `fetch()` gives up with
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY, which surfaces as a bare `TypeError:
// fetch failed` with the reason buried in `cause`.
//
// That is OUR rule keeping a WILLING store off the site, which is the failure
// this repository exists to avoid, and it is invisible from every angle:
//
//   * the price pass files the error under the same `null` a Cloudflare block
//     gives, so `priceSource` stays NULL and no price is ever stored;
//   * `linkFailures` climbs on a store that answers perfectly, and six of those
//     park the row on the slow cadence;
//   * an unpriced row is HIDDEN outright on a RELEASED set, so the vendor
//     publishes nothing at all;
//   * and the publishing report reaches its "every attempt ended with no answer
//     at all, which is what a BLOCK looks like from here" sentence — which is
//     the one thing it is not. The host answers. We hang up on it.
//
// Probed from a runner on 2026-09-11 (#170) and again on 2026-09-12, auramech.com
// and hineybush.com are both in exactly that state: live Shopify storefronts,
// serving browsers normally, unreadable to Node alone. Three listings across two
// vendors today, and a class that silently swallows every future store whose
// certificate chain is configured the same way.
//
// THE REPAIR MAY NEVER LOOSEN VERIFICATION. Fetching the missing intermediate
// and handing it to OpenSSL as `ca` makes it a TRUST ANCHOR, so a MITM could
// serve its own leaf, point the AIA at its own "intermediate", and be believed.
// Every certificate this module fetches is therefore checked against the real
// root store BEFORE it is used — `issuedByTrustedRoot` below — so the repaired
// bundle only ever contains a certificate that a full-chain server could have
// sent us anyway. The final request runs with `rejectUnauthorized: true`, like
// every other request this codebase makes. A certificate that does not chain to
// a trusted root is refused and the row keeps the error it had.
import { connect as tlsConnect, rootCertificates } from "node:tls";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { X509Certificate } from "node:crypto";

/**
 * The OpenSSL codes that mean "the chain handed to me is incomplete".
 *
 * Both spellings are the same server misconfiguration seen from two angles:
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY when no candidate issuer is in the store at
 * all, UNABLE_TO_VERIFY_LEAF_SIGNATURE when the presented chain stops short of
 * one. Deliberately just these two — every other TLS failure is a live site
 * with a real problem (an expired certificate, a hostname mismatch, a rejected
 * handshake) and none of them is repairable by fetching an issuer, so a wider
 * list would only spend a connection learning that again. rectangles.store,
 * probed the same morning, answers ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE —
 * the server refusing our hello, not a chain we can complete — and is correctly
 * outside this list.
 */
export const INCOMPLETE_CHAIN_ERROR_MARKERS = [
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
];

/** Longest this module waits for one connection or one issuer download. */
const TLS_PROBE_TIMEOUT_MS = 8000;

/**
 * How many issuers deep the repair will walk.
 *
 * One missing intermediate is the ordinary misconfiguration; two happens when a
 * CA has a cross-signed root. Past that the server is not "missing a
 * certificate", it is not serving a usable chain at all, and each extra hop is
 * another fetch inside a time-boxed price run.
 */
const MAX_ISSUER_HOPS = 2;

/** Biggest certificate download accepted, so a wrong URL cannot stream forever. */
const MAX_ISSUER_BYTES = 64 * 1024;

/**
 * Repairs settled this run, keyed by `host:port`. `null` means "asked, and this
 * host cannot be repaired" — remembered so a store that simply has a broken
 * certificate is not re-probed once per listing, exactly as `hostResolution`
 * and `frontPageCache` remember their own answers.
 *
 * Per RUN, never across runs: a store that fixes its chain must be read
 * normally on the next one.
 */
const chainRepairs = new Map();

/** Forget every repair. Called at the start of each price run. */
export function clearChainRepairs() {
  chainRepairs.clear();
}

/** How many hosts this run has repaired — for the run summary. */
export function repairedChainHosts() {
  return [...chainRepairs.entries()].filter(([, v]) => v !== null).map(([k]) => k);
}

/** Walk an error and its causes for one of the incomplete-chain codes. */
export function isIncompleteChainError(err) {
  const seen = new Set();
  const stack = [err];
  while (stack.length > 0 && seen.size < 20) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const code = typeof node.code === "string" ? node.code : "";
    const message = typeof node.message === "string" ? node.message : "";
    if (INCOMPLETE_CHAIN_ERROR_MARKERS.some((m) => code === m || message.includes(m))) {
      return true;
    }
    if (node.cause) stack.push(node.cause);
    if (Array.isArray(node.errors)) stack.push(...node.errors);
  }
  return false;
}

/**
 * The issuer-certificate URLs named by a certificate's AIA extension.
 *
 * Node renders the extension as a newline-separated `label:value` block, and
 * the values are themselves URLs containing a colon — so the split has to be on
 * the FIRST colon only. "OCSP - URI" lines sit in the same block and are not
 * certificates; taking them would spend the repair's one download on a
 * revocation responder.
 */
export function caIssuerUrls(infoAccess) {
  const urls = [];
  for (const line of String(infoAccess ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const label = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (label !== "CA Issuers - URI") continue;
    if (/^https?:\/\//i.test(value)) urls.push(value);
  }
  return urls;
}

/** DER bytes as a PEM block. Issuer downloads are usually DER, not PEM. */
export function derToPem(der) {
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** Parse a downloaded issuer, which may arrive as DER or as PEM. */
function parseIssuer(buffer) {
  const text = buffer.toString("latin1");
  const pem = text.includes("-----BEGIN CERTIFICATE-----") ? text : derToPem(buffer);
  return new X509Certificate(pem);
}

let trustedRoots = null;
function roots() {
  if (trustedRoots === null) {
    trustedRoots = [];
    for (const pem of rootCertificates) {
      try {
        trustedRoots.push(new X509Certificate(pem));
      } catch {
        // A root the runtime ships and this Node cannot parse is simply not a
        // root we can check against; skipping it can only ever refuse a repair.
      }
    }
  }
  return trustedRoots;
}

/**
 * True when `cert` was really issued by a certificate in the system root store.
 *
 * This is the whole safety of the repair, and it is checked on the certificate
 * itself rather than inferred from a successful handshake: a fetched
 * intermediate placed in `ca` becomes a trust anchor, so OpenSSL would report
 * `authorized` for a chain that stops AT it. Both halves are required —
 * `checkIssued` compares names, `verify` checks the signature — because the
 * first alone is only a claim about who the issuer says it is.
 */
export function issuedByTrustedRoot(cert) {
  for (const root of roots()) {
    try {
      if (cert.checkIssued(root) && cert.verify(root.publicKey)) return true;
    } catch {
      // Mismatched key types throw rather than returning false; keep looking.
    }
  }
  return false;
}

/** Read a server's own certificate without authorizing anything with it. */
function peerCertificate(host, port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    // rejectUnauthorized:false is safe HERE and only here: this connection is
    // never used to transfer anything. It exists to read the certificate the
    // server presents, which is public information it hands every client, and
    // the certificate is then checked against the real root store before any
    // request is made over a repaired connection.
    const socket = tlsConnect(
      { host, port, servername: host, rejectUnauthorized: false },
      () => done(socket.getPeerCertificate(false))
    );
    socket.setTimeout(TLS_PROBE_TIMEOUT_MS, () => done(null));
    socket.on("error", () => done(null));
  });
}

/** GET one issuer certificate. Plain http is normal for AIA and is fine: the
 * bytes are verified cryptographically, not trusted because of the transport. */
function downloadIssuer(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let target;
    try {
      target = new URL(url);
    } catch {
      return done(null);
    }
    const get = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = get(target, { method: "GET", timeout: TLS_PROBE_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done(null);
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ISSUER_BYTES) {
          res.destroy();
          return done(null);
        }
        chunks.push(chunk);
      });
      res.on("end", () => done(chunks.length > 0 ? Buffer.concat(chunks) : null));
      res.on("error", () => done(null));
    });
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.on("error", () => done(null));
    req.end();
  });
}

/**
 * The CA bundle that completes this host's chain, or null if it cannot be
 * completed safely.
 *
 * Memoized per host per run: the probe costs a TLS connection plus a download,
 * and a vendor with 200 listings would otherwise pay it 200 times inside a
 * twelve-minute budget — the cost `hostResolution` was added to stop paying for
 * dead domains.
 */
export async function repairedCaFor(host, port = 443) {
  const key = `${host}:${port}`;
  if (chainRepairs.has(key)) return chainRepairs.get(key);
  // Claim the host first so parallel lanes do not all probe it at once.
  chainRepairs.set(key, null);

  const peer = await peerCertificate(host, port);
  if (!peer?.raw) return null;

  let current;
  try {
    current = new X509Certificate(derToPem(peer.raw));
  } catch {
    return null;
  }

  const fetched = [];
  for (let hop = 0; hop < MAX_ISSUER_HOPS; hop++) {
    const urls = caIssuerUrls(current.infoAccess);
    if (urls.length === 0) return null;
    let issuer = null;
    for (const url of urls) {
      const body = await downloadIssuer(url);
      if (!body) continue;
      try {
        const candidate = parseIssuer(body);
        // The certificate we fetched must really be this one's issuer, or the
        // AIA pointed somewhere unrelated and the bundle would be noise.
        if (current.checkIssued(candidate) && current.verify(candidate.publicKey)) {
          issuer = candidate;
          break;
        }
      } catch {
        // Not a certificate, or a key type this Node cannot check — try the
        // next URL the extension named.
      }
    }
    if (!issuer) return null;
    fetched.push(issuer.toString());
    if (issuedByTrustedRoot(issuer)) {
      const ca = [...rootCertificates, ...fetched];
      chainRepairs.set(key, ca);
      return ca;
    }
    current = issuer;
  }
  // Walked as far as we go and never reached a real root. Refusing is the whole
  // point: an intermediate that anchors nowhere would become a trust anchor of
  // its own if we used it.
  return null;
}

/**
 * One request over a connection whose chain has been completed, as a `Response`.
 *
 * `https.request` rather than `fetch()` because Node's fetch has no way to take
 * a per-request CA bundle — undici's `dispatcher` is not reachable from core,
 * and NODE_EXTRA_CA_CERTS is read once at startup. Redirects are followed by
 * hand so the FINAL url can be reported: `isGoneRedirect` and `isGoneFrontPage`
 * both judge a row on where the request landed, and a Response built from a
 * hand-followed chain reports `url` as "" unless it is set.
 */
export function fetchWithCa(url, { headers = {}, ca, signal, maxHops = 10, follow = true } = {}) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (current) => {
      let target;
      try {
        target = new URL(current);
      } catch (err) {
        return reject(err);
      }
      if (target.protocol !== "https:") {
        // An http hop needs no repaired chain — hand it back to fetch(), which
        // keeps one code path for everything that is not a TLS problem.
        return fetch(current, { headers, signal }).then(resolve, reject);
      }
      const req = httpsRequest(
        target,
        { method: "GET", headers, ca, servername: target.hostname, timeout: TLS_PROBE_TIMEOUT_MS },
        (res) => {
          const location = res.headers.location;
          if (follow && res.statusCode >= 300 && res.statusCode < 400 && location) {
            res.resume();
            if (++hops > maxHops) return reject(new Error("too many redirects"));
            return go(new URL(location, current).href);
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const response = new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: Object.fromEntries(
                Object.entries(res.headers).filter(([, v]) => typeof v === "string")
              ),
            });
            // Response.url is read-only and is what every gone-detection rule
            // reads; without this the repaired path would report "" and
            // isGoneRedirect could never fire on a repaired host.
            Object.defineProperty(response, "url", { value: current });
            resolve(response);
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error("tls-chain request timeout"));
      });
      req.on("error", reject);
      if (signal) {
        if (signal.aborted) {
          req.destroy(signal.reason ?? new Error("aborted"));
        } else {
          signal.addEventListener("abort", () => req.destroy(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        }
      }
      req.end();
    };
    go(url);
  });
}

/**
 * Retry one request with the host's chain completed, or rethrow.
 *
 * The single entry point a caller needs: it answers only for the incomplete
 * chain, and for everything else it rethrows the original error unchanged, so
 * no other failure mode can reach a different verdict because of this module.
 */
export async function retryWithRepairedChain(url, err, { headers, signal, follow = true } = {}) {
  if (!isIncompleteChainError(err)) throw err;
  let host;
  let port;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : 443;
  } catch {
    throw err;
  }
  const ca = await repairedCaFor(host, port);
  if (!ca) throw err;
  return fetchWithCa(url, { headers, ca, signal, follow });
}
