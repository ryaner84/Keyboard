-- CreateEnum
CREATE TYPE "GBStatus" AS ENUM ('INTEREST_CHECK', 'ACTIVE_GB', 'SHIPPING', 'DELIVERED', 'IN_STOCK', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KitType" AS ENUM ('BASE', 'NUMPAD', 'MAC', 'NOVELTIES', 'SPACEBARS', 'ISO', 'ADDON');

-- CreateEnum
CREATE TYPE "Region" AS ENUM ('US', 'CA', 'EU', 'UK', 'AU', 'SG', 'ASIA', 'OTHER');

-- CreateTable
CREATE TABLE "GroupBuy" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "colorway" TEXT,
    "designer" TEXT NOT NULL,
    "status" "GBStatus" NOT NULL,
    "gbStart" TIMESTAMP(3),
    "gbEnd" TIMESTAMP(3),
    "imageUrl" TEXT,
    "description" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupBuy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Kit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "KitType" NOT NULL,
    "groupBuyId" TEXT NOT NULL,

    CONSTRAINT "Kit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "region" "Region" NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "websiteUrl" TEXT NOT NULL,
    "logoUrl" TEXT,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorKit" (
    "id" TEXT NOT NULL,
    "kitId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "currency" TEXT,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "gbUrl" TEXT,
    "productUrl" TEXT,
    "priceUpdatedAt" TIMESTAMP(3),
    "priceSource" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingZone" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "destinationRegion" "Region" NOT NULL,
    "baseShippingCost" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "estimatedDaysMin" INTEGER NOT NULL,
    "estimatedDaysMax" INTEGER NOT NULL,
    "shipsToRegion" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ShippingZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Currency" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchangeRateToUSD" DOUBLE PRECISION NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Currency_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupBuy_slug_key" ON "GroupBuy"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_slug_key" ON "Vendor"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "VendorKit_kitId_vendorId_key" ON "VendorKit"("kitId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingZone_vendorId_destinationRegion_key" ON "ShippingZone"("vendorId", "destinationRegion");

-- AddForeignKey
ALTER TABLE "Kit" ADD CONSTRAINT "Kit_groupBuyId_fkey" FOREIGN KEY ("groupBuyId") REFERENCES "GroupBuy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorKit" ADD CONSTRAINT "VendorKit_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorKit" ADD CONSTRAINT "VendorKit_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingZone" ADD CONSTRAINT "ShippingZone_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
