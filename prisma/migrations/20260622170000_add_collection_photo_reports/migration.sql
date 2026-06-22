CREATE TABLE "CollectionPhotoReport" (
    "id" TEXT NOT NULL,
    "trackerItemId" TEXT NOT NULL,
    "collectionSlug" TEXT NOT NULL,
    "buildIndex" INTEGER NOT NULL DEFAULT 0,
    "imageHash" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "notes" TEXT,
    "reporterIpHash" TEXT,
    "reporterUserId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionPhotoReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CollectionPhotoReport_trackerItemId_imageHash_submittedAt_idx"
ON "CollectionPhotoReport"("trackerItemId", "imageHash", "submittedAt");

CREATE INDEX "CollectionPhotoReport_submittedAt_idx"
ON "CollectionPhotoReport"("submittedAt");

ALTER TABLE "CollectionPhotoReport"
ADD CONSTRAINT "CollectionPhotoReport_trackerItemId_fkey"
FOREIGN KEY ("trackerItemId") REFERENCES "TrackerItem"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
