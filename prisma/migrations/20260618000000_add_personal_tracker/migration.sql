-- Personal tracker identity, passwordless challenges, tracked catalog items,
-- and durable notification delivery queue.
CREATE TABLE "TrackerUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "countryCode" TEXT,
    "region" TEXT,
    "currency" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackerUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrackerAuthChallenge" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "magicTokenHash" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ipHash" TEXT,
    "pendingSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "countryCode" TEXT,
    "region" TEXT,
    "currency" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackerAuthChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrackerItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupBuyId" TEXT NOT NULL,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT,
    "lastBestPriceUsd" DOUBLE PRECISION,
    "lastVendorCount" INTEGER NOT NULL DEFAULT 0,
    "lastDevUpdateAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackerItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrackerNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackerItemId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "TrackerNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackerUser_email_key" ON "TrackerUser"("email");
CREATE UNIQUE INDEX "TrackerAuthChallenge_magicTokenHash_key" ON "TrackerAuthChallenge"("magicTokenHash");
CREATE INDEX "TrackerAuthChallenge_email_requestedAt_idx" ON "TrackerAuthChallenge"("email", "requestedAt");
CREATE INDEX "TrackerAuthChallenge_expiresAt_idx" ON "TrackerAuthChallenge"("expiresAt");
CREATE UNIQUE INDEX "TrackerItem_userId_groupBuyId_key" ON "TrackerItem"("userId", "groupBuyId");
CREATE INDEX "TrackerItem_groupBuyId_idx" ON "TrackerItem"("groupBuyId");
CREATE UNIQUE INDEX "TrackerNotification_fingerprint_key" ON "TrackerNotification"("fingerprint");
CREATE INDEX "TrackerNotification_userId_sentAt_idx" ON "TrackerNotification"("userId", "sentAt");

ALTER TABLE "TrackerItem"
ADD CONSTRAINT "TrackerItem_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "TrackerUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackerItem"
ADD CONSTRAINT "TrackerItem_groupBuyId_fkey"
FOREIGN KEY ("groupBuyId") REFERENCES "GroupBuy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackerNotification"
ADD CONSTRAINT "TrackerNotification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "TrackerUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackerNotification"
ADD CONSTRAINT "TrackerNotification_trackerItemId_fkey"
FOREIGN KEY ("trackerItemId") REFERENCES "TrackerItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
