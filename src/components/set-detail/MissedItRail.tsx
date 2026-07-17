import Image from "next/image";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { normalizeImageUrl } from "@/lib/utils";
import type { GBStatus } from "@/types";

export interface MissedItCard {
  slug: string;
  name: string;
  status: GBStatus;
  imageUrl: string | null;
  // Why this card is suggested — a later round of the same set, or another
  // set by the same designer.
  reason: "round" | "designer";
}

// Shown ONLY when the current set has no purchasable vendor: recovery paths
// out of the "I missed it" moment — a purchasable round of the same family
// first, then other available sets by the same designer. (Colorway strings in
// this dataset are just the set name echoed, so they can't drive "similar
// colorway" matching — designer is the signal that actually exists.)
export function MissedItRail({
  cards,
  designer,
  countryCode,
}: {
  cards: MissedItCard[];
  designer: string | null;
  countryCode: string;
}) {
  if (cards.length === 0) return null;
  const hasRound = cards.some((card) => card.reason === "round");

  return (
    <section className="mt-6 rounded-2xl border border-gray-100 bg-white p-5">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-500">
        Missed it?
      </p>
      <h2 className="mt-1 font-semibold text-gray-900">
        {hasRound
          ? "A newer round is available"
          : designer
            ? `More from ${designer}, available now`
            : "Available alternatives"}
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((card) => {
          const imageUrl = normalizeImageUrl(card.imageUrl);
          return (
            <Link
              key={card.slug}
              href={`/sets/${card.slug}?country=${countryCode}`}
              className="group overflow-hidden rounded-xl border border-gray-200 transition hover:border-indigo-300"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-gray-100">
                {imageUrl ? (
                  <Image
                    src={imageUrl}
                    alt={card.name}
                    fill
                    unoptimized
                    className="object-cover transition duration-500 group-hover:scale-[1.03]"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-2xl text-gray-300">
                    ⌨
                  </span>
                )}
                {card.reason === "round" && (
                  <span className="absolute left-2 top-2 rounded-full bg-indigo-600 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
                    Same set
                  </span>
                )}
              </div>
              <div className="px-3 py-2">
                <p className="truncate text-xs font-semibold text-gray-900 group-hover:text-indigo-700">
                  {card.name}
                </p>
                <div className="mt-1">
                  <StatusBadge status={card.status} />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
