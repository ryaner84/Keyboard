// Resolves the Postgres connection string from environment variables.
//
// Three supported setups (checked in this order):
//
//   A) Full DATABASE_URL — holds the entire connection string (password included).
//
//   B) DATABASE_URL with placeholder — contains the literal token `__PASSWORD__`
//      where the password goes; DATABASE_PASSWORD holds the password, spliced in.
//
//   C) Supabase components — no DATABASE_URL at all; the string is assembled from:
//        SUPABASE_PROJECT_REF  (e.g. csvgqiuofaofomxnyfer)
//        SUPABASE_REGION       (e.g. ap-southeast-1)
//        DATABASE_PASSWORD     (the database password)
//      Optional override: SUPABASE_DB_HOST (if your pooler host isn't the default
//      `aws-0-<region>.pooler.supabase.com`).
//
// Setups B and C keep the secret password in its own variable.
//
// All resolved URLs are run through ensureTransactionPooler() — session pooler
// (port 5432) is capped at 15 clients which serverless functions saturate easily;
// transaction pooler (port 6543) has no per-client cap.
export function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  const password = process.env.DATABASE_PASSWORD;

  // A) / B) explicit DATABASE_URL wins if present.
  if (url) {
    if (url.includes("__PASSWORD__")) {
      if (!password) {
        throw new Error(
          "DATABASE_URL contains the __PASSWORD__ placeholder but DATABASE_PASSWORD is not set"
        );
      }
      return ensureTransactionPooler(url.replace("__PASSWORD__", encodeURIComponent(password)));
    }
    return ensureTransactionPooler(url);
  }

  // C) assemble from Supabase components.
  const ref = process.env.SUPABASE_PROJECT_REF;
  const region = process.env.SUPABASE_REGION;
  if (ref && region) {
    if (!password) {
      throw new Error(
        "DATABASE_PASSWORD is required when using SUPABASE_PROJECT_REF + SUPABASE_REGION"
      );
    }
    const host =
      process.env.SUPABASE_DB_HOST || `aws-0-${region}.pooler.supabase.com`;
    const pw = encodeURIComponent(password);
    // Use port 6543 directly — transaction pooler has no client cap.
    return `postgresql://postgres.${ref}:${pw}@${host}:6543/postgres`;
  }

  throw new Error(
    "No database configuration found. Set DATABASE_URL, or SUPABASE_PROJECT_REF + SUPABASE_REGION + DATABASE_PASSWORD."
  );
}

// Session pooler (port 5432) caps at 15 concurrent clients — fatal in serverless.
// Always redirect to the transaction pooler (port 6543) which has no per-client cap.
function ensureTransactionPooler(url: string): string {
  return url.replace(/:5432(\/|$)/, ":6543$1");
}
