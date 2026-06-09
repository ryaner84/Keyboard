-- Add multi-image gallery support to GroupBuy
ALTER TABLE "GroupBuy" ADD COLUMN "images" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;

-- Backfill from the existing single imageUrl so the carousel has at least one image
UPDATE "GroupBuy" SET "images" = ARRAY["imageUrl"] WHERE "imageUrl" IS NOT NULL;
