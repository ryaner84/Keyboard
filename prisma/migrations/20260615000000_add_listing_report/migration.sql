-- Visitor-submitted listing-quality reports. Write-only from the site.
CREATE TABLE IF NOT EXISTS "ListingReport" (
    "id"          TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "issueType"   TEXT NOT NULL,
    "notes"       TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ListingReport_submittedAt_idx" ON "ListingReport"("submittedAt");
