import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { verifyAdminToken } from "@/lib/auth";
import { SHOWCASE_VENDORS, HIDDEN_SLUGS, cleanDisplayName, notCustomWhere } from "@/lib/showcase";
import type { GBStatus } from "@/generated/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  // "all" is a client-side sentinel meaning "no status filter" — never a real
  // enum value, so strip it before it reaches Prisma (otherwise the enum
  // validation throws and the whole query 500s).
  const statuses = (searchParams.getAll("status") as string[]).filter(
    (s) => s !== "all"
  ) as GBStatus[];
  const search = searchParams.get("search") ?? "";
  const sortBy = searchParams.get("sort") ?? "date-desc";
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = parseInt(searchParams.get("limit") ?? "20");
  const finishing = searchParams.get("finishing"); // days until gbEnd
  const newDays = searchParams.get("new"); // days since gbStart
  const productType = searchParams.get("type"); // "KEYCAPS" | "KEYBOARD" | null (all)
  // Keyboard-specific spec filters (multi-value, OR within each group)
  const layouts = searchParams.getAll("layout");
  const mounts = searchParams.getAll("mount");
  const materialsParam = searchParams.getAll("material");
  // Maker/designer filter (multi-value). Showcase boards have no stored designer,
  // so each value matches either the designer column OR the board name (which
  // leads with the maker, e.g. "Meletrix Zoom65").
  const designers = searchParams.getAll("designer").filter(Boolean).slice(0, 50);
  const slugs = searchParams.getAll("slug").filter(Boolean).slice(0, 100);
  // Drop browse-only showcase vendors (Lightning Keyboards) at the query level
  // so pagination/counts reflect real group buys — filtering them client-side
  // after a limited fetch silently empties pages that are all-showcase rows.
  const excludeShowcase = searchParams.get("excludeShowcase") === "1";
  // The /showcase gallery sets this to restrict results to showcase sources
  // (Lightning Keyboards) only. Every other KEYBOARD row is real vendor data
  // (Oblotzky Industries, ClickClack, …) that belongs in the Keyboard Catalog,
  // not the community showcase.
  const showcaseOnly = searchParams.get("showcaseOnly") === "1";

  const now = new Date();
  let dateFilter: Record<string, unknown> = {};
  if (finishing) {
    const end = new Date(now.getTime() + Number(finishing) * 24 * 60 * 60 * 1000);
    dateFilter = { status: "ACTIVE_GB", gbEnd: { gte: now, lte: end } };
  } else if (newDays) {
    const start = new Date(now.getTime() - Number(newDays) * 24 * 60 * 60 * 1000);
    dateFilter = { status: "ACTIVE_GB", gbStart: { gte: start, lte: now } };
  }

  // Conditions that must AND together. Kept in one array so multiple
  // independent filters (showcase exclusion + privacy denylist) compose without
  // clobbering each other when spread into the same `where` object.
  const andConditions: Record<string, unknown>[] = [];
  // NULL-safe exclusion: `notIn` alone drops rows where vendorName is NULL,
  // so OR it with an explicit null check to keep vendorless group buys.
  if (excludeShowcase) {
    andConditions.push({
      OR: [{ vendorName: null }, { vendorName: { notIn: SHOWCASE_VENDORS } }],
    });
  }
  // Showcase-only: keep just the community photo sources; drop every vendor row.
  if (showcaseOnly) {
    andConditions.push({ vendorName: { in: SHOWCASE_VENDORS } });
  }
  // Privacy denylist — never surfaced anywhere, in any view.
  if (HIDDEN_SLUGS.length > 0) {
    andConditions.push({ slug: { notIn: HIDDEN_SLUGS } });
  }
  // Custom collection pieces are private to one owner — never in the catalog.
  andConditions.push(notCustomWhere);
  // Designer filter: OR across selected makers, each matching the stored
  // designer or the board name (covers showcase boards with no designer column).
  if (designers.length > 0) {
    andConditions.push({
      OR: designers.flatMap((d) => [
        { designer: { contains: d, mode: "insensitive" as const } },
        { name: { contains: d, mode: "insensitive" as const } },
      ]),
    });
  }

  const where = {
    ...(statuses.length > 0 && { status: { in: statuses } }),
    ...dateFilter,
    ...(productType && { productType }),
    ...(layouts.length > 0 && { layout: { in: layouts } }),
    ...(mounts.length > 0 && { mountingStyle: { in: mounts } }),
    ...(materialsParam.length > 0 && { material: { in: materialsParam } }),
    ...(slugs.length > 0 && { slug: { in: slugs } }),
    ...(andConditions.length > 0 && { AND: andConditions }),
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
      : sortBy === "date-asc"
        ? { createdAt: "asc" as const }
        : sortBy === "ending-soon"
          ? { gbEnd: "asc" as const }
          : { createdAt: "desc" as const };

  const [total, data] = await Promise.all([
    prisma.groupBuy.count({ where }),
    prisma.groupBuy.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        kits: {
          include: {
            vendorKits: {
              include: { vendor: { include: { shippingZones: true } } },
            },
          },
        },
      },
    }),
  ]);

  // Strip the showcase source out of display names (e.g. the scraped
  // "… — Lightning Keyboards" suffix) before any client renders them.
  const cleaned = data.map((row) => ({
    ...row,
    name: cleanDisplayName(row.name),
  }));

  return NextResponse.json({ data: cleaned, total, page, limit });
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  if (!token || !verifyAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const groupBuy = await prisma.groupBuy.create({ data: body });
  return NextResponse.json(groupBuy, { status: 201 });
}
