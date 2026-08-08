import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanDisplayName, notHiddenWhere, notShowcaseWhere } from "@/lib/showcase";
import { isKeycapMaker, makerWhereOr } from "@/lib/set-name";
import { classifyVariant, parseVariants } from "@/lib/kit-variants";
import { bestDiscount } from "@/lib/pricing";

const RELEASED_STATUSES = ["SHIPPING", "DELIVERED", "IN_STOCK"] as const;
const VISIBLE_LISTING_WHERE = { dataTrustLevel: { not: "DEAD" } } as const;

// "Available" means at least one vendor has a current price and its selected
// base-kit variant is currently purchasable.
const AVAILABLE_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: { some: { price: { not: null }, inStock: true } },
    },
  },
};

// Bargain is a price-comparison page, so every row must carry a real retail
// price from some vendor. Geekhack-sourced rows ("[GB] …" titles, gh- slugs)
// are forum THREADS, not listings — no retailer, no price, nothing to compare.
// They were reaching the page because the price requirement only applied on the
// "Available now" tab: 21 of a 192-row sample were forum posts, every one
// unpriced. Applied unconditionally, "Sold out" now means priced-but-gone
// rather than "no price at all".
const PRICED_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: { some: { price: { not: null } } },
    },
  },
};

// Rows where some vendor is running a markdown (compare_at_price > price) AND
// will still sell it to you.
//
// The three conditions live in ONE `some` on purpose: as separate filters they
// could be satisfied by different vendor rows, so a set could qualify because
// vendor A is in stock and vendor B (sold out) is discounted. In stock is part
// of the claim rather than a separate availability filter because "on sale"
// means buyable at a markdown — a discount on a listing nobody can buy is a
// price-history footnote, not a deal.
const ON_SALE_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: {
        some: { price: { not: null }, compareAtPrice: { not: null }, inStock: true },
      },
    },
  },
};

const PRICING_INCLUDE = {
  kits: {
    include: {
      vendorKits: {
        include: { vendor: { include: { shippingZones: true } } },
      },
    },
  },
} as const;

const RANKING_CAP = 400;
// The markdown rail reads full pricing rows, but ON_SALE_FILTER is very
// selective (a few dozen listings), so it needs nothing like RANKING_CAP.
const MARKDOWN_SCAN_CAP = 120;

// Sets sold as a "base + extras" bundle by at least one in-stock vendor.
//
// A bundle is not a Kit row — KitType has no BUNDLE member — it is a variant
// title inside a listing's scraped `variants` JSON, so it cannot be expressed
// as a Prisma `where`. Scanning every set's JSON in Node would mean pulling
// the whole catalog's variant lists on each request, so the coarse cut happens
// in Postgres: keep only listings whose variant blob mentions a base AND an
// extra kit. That is a strict SUPERSET of what classifyVariant() calls BUNDLE
// (every bundle title contains both), so re-running the real classifier on the
// handful of survivors gives the exact set — no false positives, none missed.
const BUNDLE_BASE_RE = "(base|ベース)";
const BUNDLE_EXTRA_RE =
  "(novelt|space ?bar|alpha|num(ber)? ?pad|40s|forties|accent|extension|hiragana|katakana|hangul|cyrillic|norde|nordic|iso|icon|macro|ノベルティ|スペースバー|アルファ)";

// Returns null when the scan could not run. This is the route's only raw SQL,
// and it runs on EVERY unfiltered page-1 load to label the pill — so a failure
// here (an older Postgres, a permissions change) would 500 the entire bargain
// page rather than lose one filter. Degrade instead: the pill loses its count,
// and an active bundle filter returns nothing rather than silently returning
// everything unfiltered under a "bundles" label.
async function bundleSetIds(): Promise<string[] | null> {
  let rows: Array<{ id: string; variants: unknown }>;
  try {
    rows = await prisma.$queryRaw<Array<{ id: string; variants: unknown }>>`
      SELECT k."groupBuyId" AS id, vk.variants
      FROM "Kit" k
      JOIN "VendorKit" vk ON vk."kitId" = k.id
      WHERE k.type = 'BASE'
        AND vk.price IS NOT NULL
        AND vk."inStock" = true
        AND vk.variants IS NOT NULL
        AND vk.variants::text ~* ${BUNDLE_BASE_RE}
        AND vk.variants::text ~* ${BUNDLE_EXTRA_RE}
    `;
  } catch (err) {
    console.error("released: bundle scan failed", err);
    return null;
  }
  const ids = new Set<string>();
  for (const row of rows) {
    const bundled = parseVariants(row.variants).some(
      (v) => classifyVariant(v.title) === "BUNDLE" && v.available !== false
    );
    if (bundled) ids.add(row.id);
  }
  return Array.from(ids);
}

interface PricedSet {
  set: { id: string; kits: Array<{ type: string; vendorKits: Array<{ price: number | null; currency: string | null; inStock: boolean }> }> };
  minUsd: number;
  maxUsd: number;
  pricedVendors: number;
}

function priceStats(
  set: PricedSet["set"],
  usdRates: Record<string, number>
): { minUsd: number; maxUsd: number; pricedVendors: number } | null {
  const base = set.kits.find((k) => k.type === "BASE") ?? set.kits[0];
  if (!base) return null;
  let min = Infinity;
  let max = 0;
  let count = 0;
  for (const vk of base.vendorKits) {
    if (vk.price == null || !vk.inStock) continue;
    const rate = usdRates[vk.currency ?? "USD"] ?? 1;
    const usd = vk.price / rate;
    count++;
    if (usd < min) min = usd;
    if (usd > max) max = usd;
  }
  if (count === 0 || !isFinite(min)) return null;
  return { minUsd: min, maxUsd: max, pricedVendors: count };
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search") ?? "";
  const availability = searchParams.get("availability") ?? "";
  const year = searchParams.get("year") ?? "";
  const designer = searchParams.get("designer") ?? "";
  const vendor = searchParams.get("vendor") ?? "";
  // Maker filter (GMK / Signature Plastics). Keycaps only — a maker pill
  // is meaningless on the keyboards tab.
  const makers = searchParams.getAll("maker").filter(isKeycapMaker);
  const onSale = searchParams.get("deals") === "1";
  const bundlesOnly = searchParams.get("bundles") === "1";
  const sortBy = searchParams.get("sort") ?? "released-desc";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const limit = Math.min(48, Math.max(1, parseInt(searchParams.get("limit") ?? "24")));
  // Released sets split into two categories. Keycaps keep the multi-vendor
  // price-compare experience; keyboards are single-vendor (price on the row),
  // so the available/savings/deals machinery is skipped for them.
  // Accept the type param case-insensitively and in either spelling — the UI
  // sends "KEYBOARD", but a hand-typed / shared link uses "keyboards", and that
  // must NOT silently fall through to keycaps (which is what surfaced GMK
  // keycap sets under /released?type=keyboards).
  const typeParam = (searchParams.get("type") ?? "").toLowerCase();
  const productType = typeParam === "keyboard" || typeParam === "keyboards" ? "KEYBOARD" : "KEYCAPS";
  const isKeyboard = productType === "KEYBOARD";

  let yearFilter: Record<string, unknown> = {};
  if (/^\d{4}$/.test(year)) {
    yearFilter = {
      gbEnd: {
        gte: new Date(`${year}-01-01T00:00:00Z`),
        lt: new Date(`${Number(year) + 1}-01-01T00:00:00Z`),
      },
    };
  }

  // The price/savings sorts and availability filter are keycap-only (they read
  // multi-vendor VendorKit prices). Keyboards ignore them entirely.
  const priceSort = !isKeyboard && sortBy === "price-asc";
  const savingsSort = !isKeyboard && sortBy === "savings-desc";
  const effectiveAvailability = isKeyboard
    ? ""
    : priceSort || savingsSort
      ? "available"
      : availability;

  // Every filter below targets `kits`, so they must be AND-ed rather than
  // spread into the same object: a second `kits` key silently REPLACES the
  // first, dropping whichever requirement came earlier. That collision already
  // existed between the availability and vendor filters; adding the price and
  // on-sale filters would have made it bite.
  // Resolved before `where` is built so the bundle filter can be pushed into
  // SQL as an id list — that keeps count/pagination exact instead of dropping
  // rows out of an already-paged result. Also computed on an unfiltered page 1
  // so the UI can label (and hide) the pill with a real number.
  const bundleIds = bundlesOnly || (page === 1 && !isKeyboard) ? await bundleSetIds() : null;

  const setConditions: Record<string, unknown>[] = [PRICED_FILTER];
  if (bundlesOnly) setConditions.push({ id: { in: bundleIds ?? [] } });
  if (effectiveAvailability === "available") setConditions.push(AVAILABLE_FILTER);
  if (effectiveAvailability === "soldout") setConditions.push({ NOT: AVAILABLE_FILTER });
  if (onSale) setConditions.push(ON_SALE_FILTER);
  if (designer) {
    setConditions.push({ designer: { equals: designer, mode: "insensitive" as const } });
  }
  if (vendor) {
    // Vendor filter = "this vendor stocks it right now".
    setConditions.push({
      kits: {
        some: {
          type: "BASE" as const,
          vendorKits: {
            some: { price: { not: null }, inStock: true, vendor: { slug: vendor } },
          },
        },
      },
    });
  }
  if (makers.length > 0) setConditions.push({ OR: makerWhereOr(makers) });

  const where = {
    ...VISIBLE_LISTING_WHERE,
    status: { in: [...RELEASED_STATUSES] },
    productType,
    ...notHiddenWhere,
    // Lightning showcase boards are DELIVERED community builds, not keyboards
    // for sale — they must never appear in the released/bargain lists.
    ...notShowcaseWhere,
    ...yearFilter,
    ...(setConditions.length > 0 && { AND: setConditions }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { designer: { contains: search, mode: "insensitive" as const } },
        { colorway: { contains: search, mode: "insensitive" as const } },
      ],
    }),
  };

  const orderBy =
    sortBy === "name"
      ? { name: "asc" as const }
      : sortBy === "released-asc"
        ? { gbEnd: { sort: "asc" as const, nulls: "last" as const } }
        : { gbEnd: { sort: "desc" as const, nulls: "last" as const } };

  const releasedWhere = { ...VISIBLE_LISTING_WHERE, status: { in: [...RELEASED_STATUSES] }, productType, ...notHiddenWhere, ...notShowcaseWhere };

  const needRates = priceSort || savingsSort || page === 1;
  const usdRates: Record<string, number> = {};
  if (needRates) {
    const rateRows = await prisma.currency.findMany({
      select: { code: true, exchangeRateToUSD: true },
    });
    for (const r of rateRows) usdRates[r.code] = r.exchangeRateToUSD;
  }

  let data: unknown[];
  let total: number;

  if (priceSort || savingsSort) {
    const all = await prisma.groupBuy.findMany({
      where,
      include: PRICING_INCLUDE,
      take: RANKING_CAP,
    });
    let ranked = all
      .map((set) => ({ set, stats: priceStats(set as never, usdRates) }))
      .filter((r) => r.stats !== null);
    if (savingsSort) {
      // Spread % between priciest and cheapest vendor; single-vendor sets
      // have no spread, so they're excluded from this view. Child-kit rounds
      // (NordeUK addons, alphas-only) are too: their £35–55 kits compared
      // against full base kits produce meaningless 60%+ "savings".
      ranked = ranked
        .filter(
          (r) =>
            r.stats!.pricedVendors >= 2 &&
            r.stats!.maxUsd > 0 &&
            !/-addon$|alphas/.test((r.set as { slug: string }).slug)
        )
        .sort(
          (a, b) =>
            (b.stats!.maxUsd - b.stats!.minUsd) / b.stats!.maxUsd -
            (a.stats!.maxUsd - a.stats!.minUsd) / a.stats!.maxUsd
        );
    } else {
      ranked = ranked.sort((a, b) => a.stats!.minUsd - b.stats!.minUsd);
    }
    total = ranked.length;
    data = ranked.slice((page - 1) * limit, page * limit).map((r) => r.set);
  } else {
    [total, data] = await Promise.all([
      prisma.groupBuy.count({ where }),
      prisma.groupBuy.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: PRICING_INCLUDE,
      }),
    ]);
  }

  // Per-category released counts power the Keycaps / Keyboards tab badges.
  const baseReleased = { ...VISIBLE_LISTING_WHERE, status: { in: [...RELEASED_STATUSES] }, ...notHiddenWhere, ...notShowcaseWhere };
  const [totalReleased, totalAvailable, totalOnSale, countKeycaps, countKeyboards] =
    await Promise.all([
      prisma.groupBuy.count({ where: releasedWhere }),
      isKeyboard
        ? Promise.resolve(0)
        : prisma.groupBuy.count({ where: { ...releasedWhere, ...AVAILABLE_FILTER } }),
      // Counted against exactly the conditions the deals=1 filter applies, so
      // the pill's number is what clicking it returns. ON_SALE_FILTER already
      // implies a price and stock, so PRICED_FILTER would be redundant here.
      isKeyboard
        ? Promise.resolve(0)
        : prisma.groupBuy.count({ where: { ...releasedWhere, ...ON_SALE_FILTER } }),
      prisma.groupBuy.count({ where: { ...baseReleased, productType: "KEYCAPS" } }),
      prisma.groupBuy.count({ where: { ...baseReleased, productType: "KEYBOARD" } }),
    ]);

  // Bundle sets that actually reach this page. bundleSetIds() answers "which
  // sets have a bundle listing" across the whole catalog, which is a larger
  // number: some are still in group buy, some have no priced base kit. Counting
  // the raw id list made the pill promise more than clicking it delivered.
  const totalBundles =
    bundleIds == null
      ? null
      : await prisma.groupBuy.count({
          where: { ...releasedWhere, AND: [PRICED_FILTER, { id: { in: bundleIds } }] },
        });

  // Top designers for the filter dropdown — only returned on page 1 with no
  // active designer filter, so the list reflects the full catalog.
  let topDesigners: string[] = [];
  if (page === 1 && !designer) {
    const rows = await prisma.groupBuy.groupBy({
      by: ["designer"],
      where: releasedWhere,
      _count: { designer: true },
      orderBy: { _count: { designer: "desc" } },
      take: 30,
    });
    topDesigners = rows.map((r) => r.designer).filter(Boolean);
  }

  // Vendors that stock at least one released set right now — for the filter
  // dropdown. Page 1 only, like topDesigners.
  let topVendors: Array<{ slug: string; name: string }> = [];
  if (page === 1) {
    topVendors = await prisma.vendor.findMany({
      where: {
        vendorKits: {
          some: {
            price: { not: null },
            inStock: true,
            kit: { type: "BASE", groupBuy: releasedWhere },
          },
        },
      },
      select: { slug: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  // "On sale now" rail — vendor markdowns (compare_at_price > price). This is a
  // different claim from the savings rail below, which measures the gap BETWEEN
  // vendors: a markdown is one shop cutting its own price, which is what a
  // shopper recognises as a sale, so it leads.
  let markdowns: unknown[] = [];
  if (!isKeyboard && page === 1 && !search && !year && !designer && !vendor && !bundlesOnly && !onSale && availability !== "soldout") {
    const onSaleSets = await prisma.groupBuy.findMany({
      where: { ...releasedWhere, ...ON_SALE_FILTER },
      include: PRICING_INCLUDE,
      take: MARKDOWN_SCAN_CAP,
    });
    markdowns = onSaleSets
      .map((set) => ({ set, discount: bestDiscount(set as never) }))
      .filter((r) => r.discount !== null)
      .sort((a, b) => b.discount!.percent - a.discount!.percent)
      .slice(0, 4)
      .map((r) => r.set);
  }

  // "Biggest savings" deals rail (keycap-only — needs multi-vendor pricing)
  let deals: unknown[] = [];
  if (!isKeyboard && page === 1 && !search && !year && !designer && !vendor && availability !== "soldout") {
    const available = await prisma.groupBuy.findMany({
      where: { ...releasedWhere, ...AVAILABLE_FILTER },
      include: PRICING_INCLUDE,
      take: RANKING_CAP,
    });
    deals = available
      .map((set) => ({ set, stats: priceStats(set as never, usdRates) }))
      .filter(
        (r): r is { set: (typeof available)[number]; stats: NonNullable<ReturnType<typeof priceStats>> } =>
          r.stats !== null &&
          r.stats.pricedVendors >= 2 &&
          r.stats.maxUsd > 0 &&
          !/-addon$|alphas/.test(r.set.slug)
      )
      .map((r) => ({
        set: r.set,
        spreadPct: ((r.stats.maxUsd - r.stats.minUsd) / r.stats.maxUsd) * 100,
      }))
      .filter((r) => r.spreadPct >= 5)
      .sort((a, b) => b.spreadPct - a.spreadPct)
      .slice(0, 4)
      .map((r) => r.set);
  }

  // /api/group-buys already cleans names on the way out; the bargain page never
  // did, which is why one Geekhack-titled row ("[GB] MW STONE Age (GB CLOSED)")
  // still read like a forum post even though it is a real, priced, in-stock
  // iLumKB listing. Applied last so nothing filters or sorts on the cleaned
  // name — matching still uses what is stored.
  const clean = (rows: unknown[]) =>
    rows.map((row) => {
      const set = row as { name?: string | null };
      return { ...set, name: cleanDisplayName(set.name) };
    });

  return NextResponse.json({
    data: clean(data),
    total,
    page,
    limit,
    totalReleased,
    totalAvailable,
    totalOnSale,
    totalBundles,
    countKeycaps,
    countKeyboards,
    markdowns: clean(markdowns),
    deals: clean(deals),
    topDesigners,
    topVendors,
  });
}
