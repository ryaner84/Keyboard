import "dotenv/config";
import { defineConfig } from "prisma/config";

// Build the connection string from env. Supports either a single DATABASE_URL
// with the password included, or a split setup where DATABASE_URL contains the
// literal token `__PASSWORD__` and DATABASE_PASSWORD holds the password.
function resolveDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  const password = process.env["DATABASE_PASSWORD"];
  if (!url) throw new Error("DATABASE_URL is not set");
  if (url.includes("__PASSWORD__")) {
    if (!password) {
      throw new Error(
        "DATABASE_URL contains __PASSWORD__ but DATABASE_PASSWORD is not set"
      );
    }
    return url.replace("__PASSWORD__", encodeURIComponent(password));
  }
  return url;
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
