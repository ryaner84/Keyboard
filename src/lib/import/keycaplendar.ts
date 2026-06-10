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

// KeycapLendar's `image` field points at the original upload under `keysets/`,
// but those are deleted after the resize extension runs — only the `thumbs/`
// copy survives (same token). Rewrite the path so the image actually loads.
function fixImageUrl(url?: string): string | null {
  if (!url) return null;
  return url.replace("keysets%2F", "thumbs%2F").replace("/keysets/", "/thumbs/");
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

export interface ImportOptions {
  // Wall-clock budget; stop starting new writes once exceeded so the cron
  // returns gracefully instead of hitting the serverless 60s kill switch.
  maxRuntimeMs?: number;
}

export interface ImportResult {
  sets: number; // sets created or updated this run
  vendors: number; // vendors created or updated this run
  vendorKits: number; // vendor-kits created or updated this run
  unchanged: number; // sets that needed no write at all
  stoppedEarly: boolean;
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

// Import all GMK keysets into the database.
//
// Diff-based: everything is prefetched in four bulk queries and compared in
// memory, so an unchanged set costs zero round trips. This matters because the
// serverless function (US) talks to a Tokyo database — per-row queries for
// ~700 sets used to blow straight through the 60s function limit.
export async function importGmkSets(opts: ImportOptions = {}): Promise<ImportResult> {
  const { maxRuntimeMs = 40_000 } = opts;
  const start = Date.now();
  const now = new Date();
  const all = await fetchAllKeysets();
  // Only import sets with a confirmed launch date — skip speculative date-less ICs.
  const gmk = all.filter(
    (k) => (k.profile ?? "").toUpperCase() === "GMK" && k.colorway && parseDate(k.gbLaunch)
  );

  const [existingSets, baseKits, existingVendors, existingVendorKits] = await Promise.all([
    prisma.groupBuy.findMany({
      select: {
        id: true, slug: true, name: true, colorway: true, designer: true,
        status: true, gbStart: true, gbEnd: true, imageUrl: true, description: true,
      },
    }),
    prisma.kit.findMany({ where: { type: "BASE" }, select: { id: true, groupBuyId: true } }),
    prisma.vendor.findMany({
      select: {
        id: true, slug: true, name: true, region: true,
        country: true, currency: true, websiteUrl: true,
      },
    }),
    prisma.vendorKit.findMany({
      select: { id: true, kitId: true, vendorId: true, inStock: true, gbUrl: true, productUrl: true },
    }),
  ]);

  const setBySlug = new Map(existingSets.map((s) => [s.slug, s]));
  const kitByGroupBuy = new Map(baseKits.map((k) => [k.groupBuyId, k.id]));
  const vendorBySlug = new Map(existingVendors.map((v) => [v.slug, v]));
  const vkByKey = new Map(existingVendorKits.map((vk) => [`${vk.kitId}:${vk.vendorId}`, vk]));

  const result: ImportResult = { sets: 0, vendors: 0, vendorKits: 0, unchanged: 0, stoppedEarly: false };

  for (const ks of gmk) {
    if (Date.now() - start > maxRuntimeMs) {
      result.stoppedEarly = true;
      break;
    }

    const name = `GMK ${ks.colorway}`;
    const slug = slugify(name);
    if (!slug) continue;

    const status = deriveStatus(ks, now);
    const designer = (ks.designer ?? []).filter(Boolean).join(" + ") || "Unknown";
    const render = fixImageUrl(ks.image);
    const gbStart = parseDate(ks.gbLaunch);
    const gbEnd = parseDate(ks.gbEnd);
    const description = ks.notes ?? null;
    const colorway = ks.colorway ?? null;

    let setChanged = false;
    const existing = setBySlug.get(slug);
    let groupBuyId: string;

    if (!existing) {
      const created = await prisma.groupBuy.create({
        data: {
          slug, name, colorway, designer, status, gbStart, gbEnd,
          imageUrl: render,
          images: render ? [render] : [],
          description,
          featured: status === "ACTIVE_GB",
        },
        select: { id: true },
      });
      groupBuyId = created.id;
      setBySlug.set(slug, { id: groupBuyId, slug, name, colorway, designer, status, gbStart, gbEnd, imageUrl: render, description });
      setChanged = true;
    } else {
      groupBuyId = existing.id;
      const dirty =
        existing.name !== name ||
        existing.colorway !== colorway ||
        existing.designer !== designer ||
        existing.status !== status ||
        !sameDate(existing.gbStart, gbStart) ||
        !sameDate(existing.gbEnd, gbEnd) ||
        existing.imageUrl !== render ||
        existing.description !== description;
      if (dirty) {
        // Leave `images` untouched so any scraped gallery survives.
        await prisma.groupBuy.update({
          where: { id: groupBuyId },
          data: { name, colorway, designer, status, gbStart, gbEnd, imageUrl: render, description },
        });
        setChanged = true;
      }
    }

    // Ensure a single BASE kit per set.
    let baseKitId = kitByGroupBuy.get(groupBuyId);
    if (!baseKitId) {
      const kit = await prisma.kit.create({
        data: { name: "Base Kit", type: "BASE", groupBuyId },
        select: { id: true },
      });
      baseKitId = kit.id;
      kitByGroupBuy.set(groupBuyId, baseKitId);
    }

    const inStock = status === "ACTIVE_GB" || status === "IN_STOCK";

    for (const v of ks.vendors ?? []) {
      if (!v.name) continue;
      const vSlug = slugify(v.name);
      if (!vSlug) continue;
      // Correct known-mislabelled vendors (e.g. SG stores tagged as "America").
      const { region, currency, country } = applyVendorOverride(vSlug, mapRegion(v.region));
      const websiteUrl = originOf(v.storeLink) || v.storeLink || "";

      let vendor = vendorBySlug.get(vSlug);
      if (!vendor) {
        const created = await prisma.vendor.create({
          data: { slug: vSlug, name: v.name, region, country, currency, websiteUrl },
          select: { id: true },
        });
        vendor = { id: created.id, slug: vSlug, name: v.name, region, country, currency, websiteUrl };
        vendorBySlug.set(vSlug, vendor);
        result.vendors++;

        // Seed DHL-estimate shipping zones for every destination region so the
        // vendor is reachable from any user location. Idempotent: skipDuplicates
        // leaves existing (or manually-edited) zones untouched.
        await prisma.shippingZone.createMany({
          data: buildShippingZones(region).map((z) => ({ vendorId: vendor!.id, ...z })),
          skipDuplicates: true,
        });
      } else if (
        vendor.name !== v.name ||
        vendor.region !== region ||
        vendor.country !== country ||
        vendor.currency !== currency ||
        vendor.websiteUrl !== websiteUrl
      ) {
        await prisma.vendor.update({
          where: { id: vendor.id },
          data: { name: v.name, region, country, currency, websiteUrl },
        });
        Object.assign(vendor, { name: v.name, region, country, currency, websiteUrl });
        result.vendors++;
      }

      const key = `${baseKitId}:${vendor.id}`;
      const existingVk = vkByKey.get(key);
      const gbUrl = v.storeLink ?? null;

      if (!existingVk) {
        // Price stays null until the price scraper fills it in.
        const created = await prisma.vendorKit.create({
          data: { kitId: baseKitId, vendorId: vendor.id, inStock, gbUrl, productUrl: gbUrl, price: null, currency },
          select: { id: true },
        });
        vkByKey.set(key, { id: created.id, kitId: baseKitId, vendorId: vendor.id, inStock, gbUrl, productUrl: gbUrl });
        result.vendorKits++;
      } else if (
        existingVk.inStock !== inStock ||
        existingVk.gbUrl !== gbUrl ||
        existingVk.productUrl !== gbUrl
      ) {
        await prisma.vendorKit.update({
          where: { id: existingVk.id },
          data: { inStock, gbUrl, productUrl: gbUrl },
        });
        Object.assign(existingVk, { inStock, gbUrl, productUrl: gbUrl });
        result.vendorKits++;
      }
    }

    if (setChanged) result.sets++;
    else result.unchanged++;
  }

  return result;
}
