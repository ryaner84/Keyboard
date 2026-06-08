import "dotenv/config";
import { defineConfig } from "prisma/config";

// Build the connection string from env. Supports: a full DATABASE_URL; a
// DATABASE_URL containing the literal token `__PASSWORD__` plus DATABASE_PASSWORD;
// or Supabase components SUPABASE_PROJECT_REF + SUPABASE_REGION + DATABASE_PASSWORD.
function resolveDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  const password = process.env["DATABASE_PASSWORD"];
  if (url) {
    if (url.includes("__PASSWORD__")) {
      if (!password) throw new Error("DATABASE_URL has __PASSWORD__ but DATABASE_PASSWORD is not set");
      return url.replace("__PASSWORD__", encodeURIComponent(password));
    }
    return url;
  }
  const ref = process.env["SUPABASE_PROJECT_REF"];
  const region = process.env["SUPABASE_REGION"];
  if (ref && region) {
    if (!password) throw new Error("DATABASE_PASSWORD is required with SUPABASE_PROJECT_REF + SUPABASE_REGION");
    const host = process.env["SUPABASE_DB_HOST"] || `aws-0-${region}.pooler.supabase.com`;
    return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres`;
  }
  throw new Error("No database configuration found (DATABASE_URL or SUPABASE_PROJECT_REF + SUPABASE_REGION + DATABASE_PASSWORD)");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: resolveDatabaseUrl(),
  },
});
