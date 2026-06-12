// KeycapLendar's per-vendor `region` field is coarse and sometimes wrong — it
// tags several Singapore/Asia stores as "America", so they end up looking like
// US vendors with expensive shipping to SG. This map corrects the region,
// country, and billing currency for vendors we know, keyed by their slug
// (slugify(vendor.name)). SG vendors matter most since SG is the primary market.
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { buildShippingZones } from "./shipping";
import type { Region } from "@/generated/prisma";

interface VendorOverride {
  region: Region;
  country: string;
  currency: string;
}

export const VENDOR_OVERRIDES: Record<string, VendorOverride> = {
  // Singapore
  ilumkb: { region: "SG", country: "SG", currency: "SGD" },
  ktechs: { region: "SG", country: "SG", currency: "SGD" },
  ktech: { region: "SG", country: "SG", currency: "SGD" },
  ashkeebs: { region: "SG", country: "SG", currency: "SGD" },
  monokei: { region: "SG", country: "SG", currency: "SGD" },
  "zion-studios": { region: "SG", country: "SG", currency: "SGD" },
  zionstudios: { region: "SG", country: "SG", currency: "SGD" },
  "zion-studios-sg": { region: "SG", country: "SG", currency: "SGD" },

  // Other Asia (kept distinct from SG for shipping math)
  kbdfans: { region: "ASIA", country: "CN", currency: "USD" },
  zfrontier: { region: "ASIA", country: "CN", currency: "USD" },
  swagkeys: { region: "ASIA", country: "KR", currency: "USD" },
  "swagkeys-kr": { region: "ASIA", country: "KR", currency: "USD" },
  geonworks: { region: "ASIA", country: "KR", currency: "USD" },
  // Indian stores — price in INR (stackskb.com shows ₹ inc. GST)
  stacks: { region: "ASIA", country: "IN", currency: "INR" },
  "neo-macro": { region: "ASIA", country: "IN", currency: "INR" },
  neomacro: { region: "ASIA", country: "IN", currency: "INR" },

  // Japan
  yushakobo: { region: "ASIA", country: "JP", currency: "JPY" },

  // Malaysia
  mecha: { region: "ASIA", country: "MY", currency: "MYR" },
  "mecha-my": { region: "ASIA", country: "MY", currency: "MYR" },

  // Latin America
  latamkeys: { region: "OTHER", country: "AR", currency: "ARS" },

  // Canada
  prototypist: { region: "CA", country: "CA", currency: "CAD" },

  // Europe / UK (KeycapLendar tags some of these as "America")
  gmk: { region: "EU", country: "DE", currency: "EUR" },
  oblotzky: { region: "EU", country: "DE", currency: "EUR" },
  "oblotzky-industries": { region: "EU", country: "DE", currency: "EUR" },
};

export function applyVendorOverride(
  slug: string,
  fallback: { region: Region; country: string; currency: string }
): { region: Region; country: string; currency: string } {
  return VENDOR_OVERRIDES[slug] ?? fallback;
}

// Vendors banned from the site entirely. Fancy Customs (CL) prices in CLP and
// repeatedly poisoned listings with six-digit "USD" prices — removed at the
// owner's request. Importers and the suggestion pipeline skip these, and
// db-setup purges any rows that sneak in.
export const BLOCKED_VENDOR_SLUGS = new Set(["fancycustoms", "fancy-customs"]);
export const BLOCKED_VENDOR_HOSTS = new Set(["fancycustoms.com", "www.fancycustoms.com"]);

// ── Hand-curated vendor product links ────────────────────────────────────────
// Product pages KeycapLendar doesn't know about (e.g. Ktechs carries GMK GBs
// but isn't listed as a vendor there). Applied on every import/refresh run so
// the scraper picks the prices up automatically.

interface VendorDef {
  name: string;
  slug: string;
  region: Region;
  country: string;
  currency: string;
  websiteUrl: string;
}

const LINK_VENDORS: VendorDef[] = [
  { name: "Ktechs", slug: "ktechs", region: "SG", country: "SG", currency: "SGD", websiteUrl: "https://ktechs.store" },
  { name: "KBDfans", slug: "kbdfans", region: "ASIA", country: "CN", currency: "USD", websiteUrl: "https://kbdfans.com" },
  { name: "Oblotzky Industries", slug: "oblotzky-industries", region: "EU", country: "DE", currency: "EUR", websiteUrl: "https://oblotzky.industries" },
  // Guaranteed-present so the catalog discovery crawler always scans their
  // group-buy AND pre-order collections (e.g. ilumkb.com/collections/pre-order-keycaps).
  { name: "iLumKB", slug: "ilumkb", region: "SG", country: "SG", currency: "SGD", websiteUrl: "https://ilumkb.com" },
  { name: "proto[Typist]", slug: "prototypist", region: "CA", country: "CA", currency: "CAD", websiteUrl: "https://prototypist.net" },
];

interface LinkOverride {
  // The set may be imported under slightly different slugs (with or without
  // the CYL profile prefix) — the first slug that exists in the DB wins.
  setSlugs: string[];
  vendorSlug: string;
  productUrl: string;
}

const LINK_OVERRIDES: LinkOverride[] = [
  {
    setSlugs: ["gmk-thunder-god", "gmk-cyl-thunder-god"],
    vendorSlug: "ktechs",
    productUrl: "https://ktechs.store/products/gmk-cyl-thunder-god",
  },
  {
    setSlugs: ["gmk-thunder-god", "gmk-cyl-thunder-god"],
    vendorSlug: "kbdfans",
    productUrl: "https://kbdfans.com/products/gmk-cyl-thunder-god",
  },
  {
    setSlugs: ["gmk-thunder-god", "gmk-cyl-thunder-god"],
    vendorSlug: "oblotzky-industries",
    productUrl: "https://oblotzky.industries/products/gmk-cyl-thunder-god",
  },
  {
    // Ktechs' group-buy page is the CURRENT round (R3) — never the 2020 R1 set.
    setSlugs: ["gmk-british-racing-green-r3", "gmk-british-racing-green"],
    vendorSlug: "ktechs",
    productUrl: "https://ktechs.store/collections/group-buy/products/gmk-british-racing-green",
  },
  {
    setSlugs: ["gmk-cyl-ramune", "gmk-ramune"],
    vendorSlug: "prototypist",
    productUrl: "https://prototypist.net/products/group-buy-gmk-cyl-ramune",
  },
];

// Daily self-heal: any vendor missing shipping-zone rows (created by the
// WorkSpace scraper between deploys, or by an older importer) gets the full
// DHL-estimate zone set. Without a zone for the viewer's region the UI used
// to hide every priced listing of that vendor.
export async function ensureShippingZonesForAllVendors(): Promise<number> {
  const vendors = await prisma.vendor.findMany({
    select: { id: true, region: true, _count: { select: { shippingZones: true } } },
  });
  let seeded = 0;
  for (const v of vendors) {
    if (v._count.shippingZones >= 8) continue;
    const res = await prisma.shippingZone.createMany({
      data: buildShippingZones(v.region).map((z) => ({ vendorId: v.id, ...z })),
      skipDuplicates: true,
    });
    seeded += res.count;
  }
  return seeded;
}

// Find or create a vendor; new vendors get DHL-estimate shipping zones so
// their rows can actually render in the price table.
async function ensureVendor(def: VendorDef): Promise<string> {
  const existing = await prisma.vendor.findUnique({ where: { slug: def.slug } });
  if (existing) return existing.id;
  const created = await prisma.vendor.create({ data: def });
  await prisma.shippingZone.createMany({
    data: buildShippingZones(def.region).map((z) => ({ vendorId: created.id, ...z })),
    skipDuplicates: true,
  });
  return created.id;
}

// Link a vendor's product page to a set's BASE kit. Never clobbers a
// manually-entered price; clears priceUpdatedAt when the URL changes so the
// scraper re-fetches it on the next run. Returns the VendorKit id so callers
// can immediately price it.
async function linkVendorKit(
  groupBuyId: string,
  vendorId: string,
  productUrl: string,
  currency: string
): Promise<string> {
  let baseKit = await prisma.kit.findFirst({ where: { groupBuyId, type: "BASE" } });
  if (!baseKit) {
    baseKit = await prisma.kit.create({ data: { name: "Base Kit", type: "BASE", groupBuyId } });
  }

  const existing = await prisma.vendorKit.findUnique({
    where: { kitId_vendorId: { kitId: baseKit.id, vendorId } },
  });

  if (existing) {
    await prisma.vendorKit.update({
      where: { id: existing.id },
      data: {
        productUrl,
        gbUrl: existing.gbUrl ?? productUrl,
        inStock: true,
        ...(existing.priceSource !== "MANUAL" && existing.productUrl !== productUrl
          ? { priceUpdatedAt: null }
          : {}),
      },
    });
    return existing.id;
  }

  const created = await prisma.vendorKit.create({
    data: {
      kitId: baseKit.id,
      vendorId,
      productUrl,
      gbUrl: productUrl,
      inStock: true,
      currency,
    },
  });
  return created.id;
}

export interface LinkOverrideResult {
  linked: number;
  skipped: number;
}

// Apply all hand-curated vendor links. Sets that aren't in the DB yet are
// skipped silently (they'll link once the importer brings them in).
export async function applyVendorLinkOverrides(): Promise<LinkOverrideResult> {
  const result: LinkOverrideResult = { linked: 0, skipped: 0 };

  const vendorIds = new Map<string, string>();
  for (const def of LINK_VENDORS) {
    vendorIds.set(def.slug, await ensureVendor(def));
  }

  for (const link of LINK_OVERRIDES) {
    // setSlugs is a priority list — `findFirst({ slug: { in } })` returns an
    // arbitrary match, so resolve in order explicitly.
    let groupBuy = null;
    for (const slug of link.setSlugs) {
      groupBuy = await prisma.groupBuy.findUnique({ where: { slug } });
      if (groupBuy) break;
    }
    if (!groupBuy) {
      result.skipped++;
      continue;
    }
    const def = LINK_VENDORS.find((v) => v.slug === link.vendorSlug)!;
    await linkVendorKit(groupBuy.id, vendorIds.get(link.vendorSlug)!, link.productUrl, def.currency);
    result.linked++;
  }

  return result;
}

// ── User-submitted vendor suggestions ────────────────────────────────────────

// Region/currency hints for stores we recognise by hostname; suggestions from
// unknown stores default to OTHER/USD — the scraper corrects the currency from
// the store's own meta.json, and implausible prices are rejected by KIT_BOUNDS.
const KNOWN_HOSTS: Record<string, Omit<VendorDef, "websiteUrl">> = {
  "ktechs.store": { name: "Ktechs", slug: "ktechs", region: "SG", country: "SG", currency: "SGD" },
  "ilumkb.com": { name: "iLumKB", slug: "ilumkb", region: "SG", country: "SG", currency: "SGD" },
  "kbdfans.com": { name: "KBDfans", slug: "kbdfans", region: "ASIA", country: "CN", currency: "USD" },
  "oblotzky.industries": { name: "Oblotzky Industries", slug: "oblotzky-industries", region: "EU", country: "DE", currency: "EUR" },
  "novelkeys.com": { name: "NovelKeys", slug: "novelkeys", region: "US", country: "US", currency: "USD" },
  "cannonkeys.com": { name: "Cannon Keys", slug: "cannon-keys", region: "US", country: "US", currency: "USD" },
  "stackskb.com": { name: "STACKS", slug: "stacks", region: "ASIA", country: "IN", currency: "INR" },
  "neomacro.in": { name: "Neo Macro", slug: "neo-macro", region: "ASIA", country: "IN", currency: "INR" },
  "latamkeys.com": { name: "Latamkeys", slug: "latamkeys", region: "OTHER", country: "AR", currency: "ARS" },
  "shop.yushakobo.jp": { name: "Yushakobo", slug: "yushakobo", region: "ASIA", country: "JP", currency: "JPY" },
  "www.mecha.com.my": { name: "Mecha", slug: "mecha", region: "ASIA", country: "MY", currency: "MYR" },
  "mecha.com.my": { name: "Mecha", slug: "mecha", region: "ASIA", country: "MY", currency: "MYR" },
  "www.deskhero.ca": { name: "DeskHero", slug: "deskhero", region: "CA", country: "CA", currency: "CAD" },
  "prototypist.net": { name: "proto[Typist]", slug: "prototypist", region: "CA", country: "CA", currency: "CAD" },
};

export interface SuggestionResult {
  processed: number;
  linked: number;
  // VendorKits created/updated this run — callers can price them right away.
  vendorKitIds: string[];
}

// Turn user-submitted vendor suggestions into VendorKits the scraper can
// price. Each suggestion is processed once; bad URLs or unknown sets are
// marked processed and dropped.
export async function processVendorSuggestions(): Promise<SuggestionResult> {
  const result: SuggestionResult = { processed: 0, linked: 0, vendorKitIds: [] };

  const pending = await prisma.vendorSuggestion.findMany({
    where: { processed: false },
    orderBy: { submittedAt: "asc" },
    take: 50,
  });

  for (const s of pending) {
    result.processed++;
    const markDone = () =>
      prisma.vendorSuggestion.update({ where: { id: s.id }, data: { processed: true } });

    let host: string;
    let origin: string;
    try {
      const u = new URL(s.productUrl);
      host = u.hostname;
      origin = u.origin;
    } catch {
      await markDone();
      continue;
    }

    if (BLOCKED_VENDOR_HOSTS.has(host)) {
      await markDone();
      continue;
    }

    const groupBuy = await prisma.groupBuy.findUnique({ where: { slug: s.slug } });
    if (!groupBuy) {
      await markDone();
      continue;
    }

    const known = KNOWN_HOSTS[host];
    const fallbackName = s.vendorName?.trim() || host.replace(/^www\./, "").split(".")[0];
    const def: VendorDef = known
      ? { ...known, websiteUrl: origin }
      : {
          name: fallbackName,
          slug: slugify(fallbackName),
          region: "OTHER",
          country: "US",
          currency: "USD",
          websiteUrl: origin,
        };
    if (!def.slug || BLOCKED_VENDOR_SLUGS.has(def.slug)) {
      await markDone();
      continue;
    }

    const vendorId = await ensureVendor(def);
    const vendorKitId = await linkVendorKit(groupBuy.id, vendorId, s.productUrl, def.currency);
    await markDone();
    result.linked++;
    result.vendorKitIds.push(vendorKitId);
  }

  return result;
}
