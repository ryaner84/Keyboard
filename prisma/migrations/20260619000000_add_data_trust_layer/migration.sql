ALTER TABLE "GroupBuy"
  ADD COLUMN IF NOT EXISTS "sourceType" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceLastCheckedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sourceLastActivityAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dataTrustLevel" TEXT NOT NULL DEFAULT 'TRUSTED',
  ADD COLUMN IF NOT EXISTS "dataTrustReason" TEXT;

UPDATE "GroupBuy"
SET
  "sourceType" = COALESCE("sourceType", 'GEEKHACK'),
  "sourceUrl" = COALESCE("sourceUrl", "productUrl")
WHERE slug LIKE 'gh-%'
   OR "productUrl" ILIKE '%geekhack.org/index.php?topic=%';

CREATE INDEX IF NOT EXISTS "GroupBuy_dataTrustLevel_idx"
  ON "GroupBuy" ("dataTrustLevel");

CREATE INDEX IF NOT EXISTS "GroupBuy_sourceType_idx"
  ON "GroupBuy" ("sourceType");
