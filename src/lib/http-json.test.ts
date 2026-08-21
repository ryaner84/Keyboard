import assert from "node:assert/strict";
import { errorMessage, readJsonBody } from "@/lib/http-json";

function res(body: string, status = 200): Response {
  return new Response(body, { status });
}

// The suite runs under CommonJS (tsconfig.test.json), so no top-level await.
async function main() {
  // ── readJsonBody ────────────────────────────────────────────────────────────

  // The case that started this: a route handler threw, Next returned a 500 with
  // an EMPTY body, and `response.json()` raised "Unexpected end of JSON input" —
  // which the catch block then showed to the user as if it were the reason their
  // sign-in code failed.
  const empty = await readJsonBody(res("", 500));
  assert.deepEqual(empty, {}, "an empty body must not throw");

  // An HTML error page is the other thing a broken route can return.
  const html = await readJsonBody(res("<!DOCTYPE html><h1>500</h1>", 500));
  assert.deepEqual(html, {}, "non-JSON must not throw");

  const ok = await readJsonBody(res(JSON.stringify({ error: "nope" }), 401));
  assert.equal(ok.error, "nope");

  // Valid JSON that isn't an object would break callers that index into it.
  for (const scalar of ["null", "3", '"a string"', "[1,2]"]) {
    assert.deepEqual(
      await readJsonBody(res(scalar)),
      {},
      `${scalar} is valid JSON but not an error payload`
    );
  }

  // ── errorMessage ────────────────────────────────────────────────────────────

  // The server's own message always wins — it knows why.
  assert.equal(
    errorMessage({ error: "That code is invalid or expired" }, res("", 401), "fallback"),
    "That code is invalid or expired"
  );

  // A 5xx is never the user's fault, so it must NOT borrow a caller fallback
  // like "Could not verify code", which reads as "your code was wrong".
  const serverSide = errorMessage({}, res("", 500), "Could not verify code");
  assert.match(serverSide, /server/i);
  assert.notEqual(serverSide, "Could not verify code");

  // A 4xx with no body does use the caller's fallback — there the caller's
  // wording is the specific one.
  assert.equal(
    errorMessage({}, res("", 400), "Could not verify code"),
    "Could not verify code"
  );

  // An empty or non-string `error` field falls through rather than rendering "".
  assert.equal(errorMessage({ error: "" }, res("", 400), "fallback"), "fallback");
  assert.equal(errorMessage({ error: 42 }, res("", 400), "fallback"), "fallback");
}

main()
  .then(() => {
    console.log("http json helper checks passed");
  })
  .catch((error) => {
    // Explicit: a rejected promise must fail the run loudly, not print
    // nothing and leave the exit code to Node's default handling.
    console.error(error);
    process.exit(1);
  });
