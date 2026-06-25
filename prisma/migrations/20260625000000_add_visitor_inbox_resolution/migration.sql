-- Visitor-inbox triage state: a nullable resolvedAt on every visitor-input
-- channel so the daily screening feed can surface UNRESOLVED items only.
-- (VendorSuggestion already carries `processed`, which serves the same role.)
-- Production provisions these idempotently in scripts/db-setup.mjs; this
-- migration keeps `prisma migrate` in sync for local development.
ALTER TABLE "Feedback"              ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone;
ALTER TABLE "PriceReport"           ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone;
ALTER TABLE "ListingReport"         ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone;
ALTER TABLE "CollectionPhotoReport" ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone;
