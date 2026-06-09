// NOTE: This module must only be imported from server code (server components,
// route handlers, import scripts). Client components import from
// "@/lib/currency-utils" instead, never from here.
import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDatabaseUrl } from "@/lib/database-url";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const connectionString = resolveDatabaseUrl();
  // max:1 — each serverless invocation is its own process; no need for >1 connection.
  const adapter = new PrismaPg({ connectionString, max: 1 });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
