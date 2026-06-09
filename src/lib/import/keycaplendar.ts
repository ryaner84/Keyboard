import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { unwrapFields, type FirestoreDoc } from "./firestore";
import { applyVendorOverride } from "./vendor-overrides";
import { buildShippingZones } from "./shipping";
import type { GBStatus, Region } from "@/generated/prisma";

const PROJECT_ID = process.env.KEYCAPLENDAR_PROJECT_ID || "keycaplendar";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/keysets`;

interface KeycapLendarVendor {
  id?: string;
  name?: string;
  region?: string;
  storeLink?: string;
}

interface Keyset {
  profile?: string;
  colorway?: string;
  designer?: string[];
  vendors?: KeycapLendarVendor[];
  icDate?: string;
  gbLaunch?: string;
  gbEnd?: string;
  gbMonth?: boolean;
  image?: string;
  shipped?: boolean;
  details?: string;
  notes?: string;
}

// Map KeycapLendar region strings to our Region enum + a default currency.
const REGION_MAP: Record<string, { region: Region; currency: string; country: string }> = {
  America: { region: "US", currency: "USD", country: "US" },
  Europe: { region: "EU", currency: "EUR", country: "DE" },
  Asia: { region: "ASIA", currency: "USD", country: "CN" },
  Oceania: { region: "AU", currency: "AUD", country: "AU" },
  Canada: { region: "CA", currency: "CAD", country: "CA" },
  UK: { region: "UK", currency: "GBP", country: "GB" },
};

function mapRegion(region?: string) {
  return (region && REGION_MAP[region]) || { region: "OTHER" as Region, currency: "USD", country: "US" };
}

// Parse a KeycapLendar date string (e.g. "2019-07-22") into a Date, or null.
function parseDate(value?: string): Date | null {
  if (!value) return null;
  // Accept full ISO dates; ignore partial/"Q1 2024" style values.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function deriveStatus(ks: Keyset, now: Date): GBStatus {
  if (ks.shipped) return "DELIVERED";
  const launch = parseDate(ks.gbLaunch);
  const end = parseDate(ks.gbEnd);
  if (end && now > end) return "SHIPPING";
  if (launch && end && launch <= now && now <= end) return "ACTIVE_GB";
  if (launch && now < launch) return "INTEREST_CHECK";
  return "INTEREST_CHECK";
}

function originOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// Fetch all keyset documents, paginating through nextPageToken.
export async function fetchAllKeysets(): Promise<Keyset[]> {
  const keysets: Keyset[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(BASE_URL);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`KeycapLendar fetch failed: ${res.status}`);
    const data = (await res.json()) as { documents?: FirestoreDoc[]; nextPageToken?: string };

    for (const doc of data.documents ?? []) {
      if (!doc.fields) continue;
      keysets.push(unwrapFields(doc.fields) as Keyset);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return keysets;
}

export interface ImportResult {
  sets: number;
  vendors: number;
  vendorKits: number;
}

// Import all GMK keysets into the database.
export async function importGmkSets(): Promise<ImportResult> {
  const now = new Date();
  const all = await fetchAllKeysets();
  const gmk = all.filter((k) => (k.profile ?? "").toUpperCase() === "GMK" && k.colorway);

  const result: ImportResult = { sets: 0, vendors: 0, vendorKits: 0 };
  const vendorCache = new Map<string, string>(); // slug -> vendorId

  for (const ks of gmk) {
    const name = `GMK ${ks.colorway}`;
    const slug = slugify(name);
    if (!slug) continue;

    const status = deriveStatus(ks, now);
    const designer = (ks.designer ?? []).filter(Boolean).join(" + ") || "Unknown";

    const groupBuy = await prisma.groupBuy.upsert({
      where: { slug },
      update: {
        name,
        colorway: ks.colorway ?? null,
        designer,
        status,
        gbStart: parseDate(ks.gbLaunch),
        gbEnd: parseDate(ks.gbEnd),
        imageUrl: ks.image ?? null,
        description: ks.notes ?? null,
      },
      create: {
        slug,
        name,
        colorway: ks.colorway ?? null,
        designer,
        status,
        gbStart: parseDate(ks.gbLaunch),
        gbEnd: parseDate(ks.gbEnd),
        imageUrl: ks.image ?? null,
        description: ks.notes ?? null,
        featured: status === "ACTIVE_GB",
      },
    });
    result.sets++;

    // Ensure a single BASE kit per set.
    let baseKit = await prisma.kit.findFirst({
      where: { groupBuyId: groupBuy.id, type: "BASE" },
    });
    if (!baseKit) {
      baseKit = await prisma.kit.create({
        data: { name: "Base Kit", type: "BASE", groupBuyId: groupBuy.id },
      });
    }

    const inStock = status === "ACTIVE_GB" || status === "IN_STOCK";

    for (const v of ks.vendors ?? []) {
      if (!v.name) continue;
      const vSlug = slugify(v.name);
      if (!vSlug) continue;
      const { region, currency, country } = mapRegion(v.region);

      // Apply known overrides before upsert (KCL mislabels some SG vendors as US/Asia).
      const { region: vendorRegion, currency: vendorCurrency, country: vendorCountry } =
        applyVendorOverride(vSlug, { region, currency, country });

      let vendorId = vendorCache.get(vSlug);
      if (!vendorId) {
        const vendor = await prisma.vendor.upsert({
          where: { slug: vSlug },
          update: {
            name: v.name,
            region: vendorRegion,
            country: vendorCountry,
            currency: vendorCurrency,
            websiteUrl: originOf(v.storeLink) || v.storeLink || "",
          },
          create: {
            slug: vSlug,
            name: v.name,
            region: vendorRegion,
            country: vendorCountry,
            currency: vendorCurrency,
            websiteUrl: originOf(v.storeLink) || v.storeLink || "",
          },
        });
        vendorId = vendor.id;
        vendorCache.set(vSlug, vendorId);
        result.vendors++;

        // Seed DHL shipping zones for every destination (skipDuplicates = safe to re-run).
        await prisma.shippingZone.createMany({
          data: buildShippingZones(vendorRegion).map((z) => ({ vendorId: vendor.id, ...z })),
          skipDuplicates: true,
        });
      }

      // Don't overwrite manually-entered prices; preserve existing price data.
      const existing = await prisma.vendorKit.findUnique({
        where: { kitId_vendorId: { kitId: baseKit.id, vendorId } },
      });

      await prisma.vendorKit.upsert({
        where: { kitId_vendorId: { kitId: baseKit.id, vendorId } },
        update: {
          inStock,
          gbUrl: v.storeLink ?? null,
          productUrl: v.storeLink ?? null,
        },
        create: {
          kitId: baseKit.id,
          vendorId,
          inStock,
          gbUrl: v.storeLink ?? null,
          productUrl: v.storeLink ?? null,
          price: existing?.price ?? null,
          currency: existing?.currency ?? currency,
        },
      });
      result.vendorKits++;
    }
  }

  return result;
}
