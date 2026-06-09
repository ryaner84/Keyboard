import { prisma } from "@/lib/prisma";
import { ImageManager } from "./ImageManager";

export const dynamic = "force-dynamic";

export default async function AdminImagesPage() {
  const sets = await prisma.groupBuy.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    select: { slug: true, name: true, status: true, images: true, imageUrl: true },
  });

  const initial = sets.map((s) => ({
    slug: s.slug,
    name: s.name,
    status: s.status,
    images: s.images && s.images.length > 0 ? s.images : s.imageUrl ? [s.imageUrl] : [],
  }));

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Set Images</h1>
      <p className="text-sm text-gray-500 mb-6">
        Add gallery images per set (e.g. gmk.net renders of each kit). The first image is used as
        the hero / share preview. Pasted URLs must start with http(s).
      </p>
      <ImageManager sets={initial} />
    </div>
  );
}
