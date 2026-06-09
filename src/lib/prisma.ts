// NOTE: This module must only be imported from server code (server components,
// route handlers, import scripts). Client components import from
// "@/lib/currency-utils" instead, never from here.
import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDatabaseUrl } from "@/lib/database-url";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const connectionString = resolveDatabaseUrl();
  // Supabase requires SSL. Skip it for local Postgres (no SSL support).
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  const ssl = isLocal ? undefined : { rejectUnauthorized: false };
  // max:1 — each serverless invocation is its own process and only ever needs
  // one connection; keeps us well under the pooler's client budget.
  const adapter = new PrismaPg({ connectionString, ssl, max: 1 });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
