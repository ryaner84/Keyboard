// Resolves the Postgres connection string from environment variables.
//
// Two supported setups:
//   A) Single var  — DATABASE_URL holds the full connection string (password included).
//   B) Split vars  — DATABASE_URL holds the string with the literal token
//                    `__PASSWORD__` where the password goes, and DATABASE_PASSWORD
//                    holds the password separately. The password is URL-encoded
//                    and spliced in here.
//
// Setup B lets you keep the secret password in its own Vercel variable.
export function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  const password = process.env.DATABASE_PASSWORD;

  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }

  if (url.includes("__PASSWORD__")) {
    if (!password) {
      throw new Error(
        "DATABASE_URL contains the __PASSWORD__ placeholder but DATABASE_PASSWORD is not set"
      );
    }
    return url.replace("__PASSWORD__", encodeURIComponent(password));
  }

  return url;
}
