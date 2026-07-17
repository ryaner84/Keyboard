import Image from "next/image";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { normalizeImageUrl } from "@/lib/utils";
import type { GBStatus } from "@/types";

export interface RoundEntry {
  slug: string;
  name: string;
  status: GBStatus;
  imageUrl: string | null;
  round: number;
  gbEnd: Date | null;
}

// Keycap round-family cross-links — the keycap analogue of the keyboard
// "Collector identification" edition card: every round of the same set
// (GMK Striker → R2 → R3), current one highlighted, so a collector landing on
// a sold-out round can jump straight to the one that's selling.
export function RoundFamilyStrip({
  rounds,
  currentSlug,
  countryCode,
}: {
  rounds: RoundEntry[];
  currentSlug: string;
  countryCode: string;
}) {
  if (rounds.length < 2) return null;

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-[#dfd2b9] bg-[#faf7f0] dark:border-[#4b402d] dark:bg-[#1d1a15]">
      <div className="border-b border-[#e7dcc8] px-5 py-4 dark:border-[#4b402d] sm:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#d0b278]">
          Set rounds
        </p>
        <h2 className="mt-1 text-lg font-semibold text-gray-950 dark:text-white">
          This colorway ran {rounds.length} times
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-gray-600 dark:text-gray-400">
          Rounds are separate production runs — legends, kit contents, and
          pricing can differ. Check the round you own or want.
        </p>
      </div>

      <div className="flex gap-3 overflow-x-auto p-4 sm:p-5">
        {rounds.map((round) => {
          const active = round.slug === currentSlug;
          const imageUrl = normalizeImageUrl(round.imageUrl);
          const year = round.gbEnd ? new Date(round.gbEnd).getFullYear() : null;
          return (
            <Link
              key={round.slug}
              href={`/sets/${round.slug}?country=${countryCode}`}
              className={`w-40 shrink-0 overflow-hidden rounded-xl border bg-white transition dark:bg-[#111417] ${
                active
                  ? "border-[#9a7a42] ring-2 ring-[#9a7a42]/20 dark:border-[#d0b278]"
                  : "border-black/10 hover:border-[#c9ab72] dark:border-white/10"
              }`}
            >
              <div className="relative aspect-[16/9] overflow-hidden bg-gray-100 dark:bg-gray-900">
                {imageUrl ? (
                  <Image
                    src={imageUrl}
                    alt={round.name}
                    fill
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-2xl text-gray-300">
                    ⌨
                  </span>
                )}
                {active && (
                  <span className="absolute left-2 top-2 rounded-full bg-[#9a7a42] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
                    You&apos;re viewing
                  </span>
                )}
              </div>
              <div className="px-3 py-2.5">
                <p className="text-sm font-bold text-gray-950 dark:text-white">
                  {round.round === 1 ? "Original run" : `Round ${round.round}`}
                  {year ? (
                    <span className="ml-1 font-normal text-gray-400">
                      · {year}
                    </span>
                  ) : null}
                </p>
                <div className="mt-1.5">
                  <StatusBadge status={round.status} />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
