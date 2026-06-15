// Runtime schema safety-net for keyboard scraping.
//
// The Vercel BUILD step runs scripts/db-setup.mjs, but that script silently
// returns if it can't reach the database during the build (which happens on
// Vercel — the build container often can't connect to Supabase). When that
// happens the keyboard columns are never created, so every scraper write at
// runtime throws ("column does not exist") and the dashboard stays empty.
//
// The cron runtime CAN reach the DB, so we ensure the columns here, right
// before scraping. Every statement is idempotent (ADD COLUMN IF NOT EXISTS).

import { prisma } from "@/lib/prisma";

const STATEMENTS: string[] = [
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "productType" text NOT NULL DEFAULT 'KEYCAPS'`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "layout" text`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "material" text`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "mountingStyle" text`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "basePrice" double precision`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "priceCurrency" text`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "productUrl" text`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "vendorName" text`,
  `ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "vendorRegion" text`,
  `CREATE TABLE IF NOT EXISTS "KeyboardContribution" (
     id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
     content text NOT NULL,
     handle text,
     "submittedAt" timestamptz NOT NULL DEFAULT now(),
     processed boolean NOT NULL DEFAULT false
   )`,
];

export interface EnsureSchemaResult {
  ok: boolean;
  applied: number;
  errors: string[];
}

export async function ensureKeyboardSchema(): Promise<EnsureSchemaResult> {
  const errors: string[] = [];
  let applied = 0;
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
      applied++;
    } catch (e) {
      errors.push(String(e));
    }
  }
  if (errors.length > 0) {
    console.warn(`[ensure-keyboard-schema] ${errors.length} statement(s) failed:`, errors[0]);
  } else {
    console.log(`[ensure-keyboard-schema] ${applied} statements OK`);
  }
  return { ok: errors.length === 0, applied, errors };
}
