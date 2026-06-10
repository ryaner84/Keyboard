-- Track when each set's gmk.net gallery was last (re)checked, so the scraper
-- rotates oldest-first and previously-polluted galleries self-heal.
ALTER TABLE "GroupBuy" ADD COLUMN IF NOT EXISTS "imagesUpdatedAt" TIMESTAMP(3);
