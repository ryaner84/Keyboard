-- Catalog discovery crawler: when each vendor's store was last scanned for
-- GMK listings (oldest-first rotation across nightly runs).
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "lastDiscoveredAt" TIMESTAMP(3);
