// Reading a fetch response that is SUPPOSED to be JSON, without assuming it is.
//
// Extracted from TrackerContext (a "use client" component, so nothing in it can
// be exercised by the ts-node suites) because this is the code that decides what
// a user is told when sign-in fails — worth a test rather than a hope.
//
// The bug it exists to prevent: a route handler that throws returns an EMPTY
// body, `response.json()` on that raises "Unexpected end of JSON input", and the
// catch block put that string in front of the user. It reads like corruption,
// says nothing about what to do, and hides the actual status.

export async function readJsonBody(
  response: Response
): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    // A valid JSON scalar ("null", "3", a bare string) is not an error payload,
    // and callers index into this — so only objects pass through.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// The server's own `error` string when it sent one, otherwise a message chosen
// from the status. A 5xx is never the user's fault and shouldn't be reported
// with a caller's fallback like "Could not verify code", which reads as "your
// code was wrong".
export function errorMessage(
  data: Record<string, unknown>,
  response: Response,
  fallback: string
): string {
  if (typeof data.error === "string" && data.error) return data.error;
  if (response.status >= 500) {
    return "The server had a problem. Please try again in a moment.";
  }
  return fallback;
}
