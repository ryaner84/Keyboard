-- VendorSuggestion: crowd-sourced vendor product URLs submitted via the UI.
-- The nightly refresh turns unprocessed rows into scrapeable VendorKits.
CREATE TABLE IF NOT EXISTS "VendorSuggestion" (
  id            text NOT NULL PRIMARY KEY,
  slug          text NOT NULL,
  "productUrl"  text NOT NULL,
  "vendorName"  text,
  "submittedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed     boolean NOT NULL DEFAULT false
);
