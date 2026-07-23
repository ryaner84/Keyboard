ALTER TABLE "TrackerItem"
ADD COLUMN IF NOT EXISTS "keycapAcquisitions" JSONB;
