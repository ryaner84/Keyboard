import Link from "next/link";
import { SetImageCarousel } from "@/components/set-detail/SetImageCarousel";
import { deriveDesigner } from "@/lib/keyboard-designers";

// Dedicated detail view for a Showcase board. Unlike a keycap set or a real
// group buy, a showcase board is a community photo build — there is nothing to
// track, price, or buy. A keyboard collector opening one wants the photos and a
// spec sheet: who made it, the layout, how it's mounted, what it's made of, and
// the colorway/finish. We publish exactly the fields the board actually carries
// and quietly omit the rest, rather than rendering empty "Designer:" / price UI.

interface ShowcaseBoard {
  slug: string;
  name: string;
  colorway?: string | null;
  designer?: string | null;
  layout?: string | null;
  material?: string | null;
  mountingStyle?: string | null;
  description?: string | null;
}

// One labeled fact in the spec sheet. Icons are inline so this stays a server
// component (no client JS for a static read-only page).
function SpecField({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-3.5 dark:border-gray-800 dark:bg-gray-900">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400">
          {label}
        </p>
        <p className="mt-0.5 break-words text-sm font-semibold text-gray-900 dark:text-white">
          {value}
        </p>
      </div>
    </div>
  );
}

const ICONS = {
  maker: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7" />
    </svg>
  ),
  layout: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path strokeLinecap="round" d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  ),
  mount: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16M7 8v8M17 8v8" />
    </svg>
  ),
  material: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l9 5v10l-9 5-9-5V7l9-5zM3 7l9 5 9-5M12 12v10" />
    </svg>
  ),
  colorway: (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3a9 9 0 100 18 3 3 0 003-3 2 2 0 012-2h1a3 3 0 003-3 9 9 0 00-12-7z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export function ShowcaseDetail({
  board,
  images,
  displayName,
}: {
  board: ShowcaseBoard;
  images: string[];
  displayName: string;
}) {
  // The maker isn't a stored column for scraped showcase boards — derive it from
  // the (already source-cleaned) board name, falling back to any stored value.
  const maker = deriveDesigner(displayName, board.designer);

  const specs: Array<{ label: string; value: string; icon: React.ReactNode }> = [];
  if (maker) specs.push({ label: "Maker", value: maker, icon: ICONS.maker });
  if (board.layout) specs.push({ label: "Layout", value: board.layout, icon: ICONS.layout });
  if (board.mountingStyle)
    specs.push({ label: "Mounting", value: board.mountingStyle, icon: ICONS.mount });
  if (board.material)
    specs.push({ label: "Case material", value: board.material, icon: ICONS.material });
  if (board.colorway)
    specs.push({ label: "Colorway", value: board.colorway, icon: ICONS.colorway });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Back to the gallery — collectors browse build-to-build */}
      <Link
        href="/showcase"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-gray-500 transition-colors hover:text-violet-600 dark:text-gray-400"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to Showcase
      </Link>

      <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900">
        {images.length > 0 && (
          <SetImageCarousel images={images} alt={displayName} />
        )}

        <div className="p-6">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
            Showcase build
          </span>

          {maker && (
            <p className="mt-3 text-xs font-bold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-400">
              {maker}
            </p>
          )}
          <h1 className="mt-1 text-2xl font-extrabold text-gray-900 dark:text-white sm:text-3xl">
            {displayName}
          </h1>

          {board.description && (
            <p className="mt-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              {board.description}
            </p>
          )}
        </div>
      </div>

      {/* Spec sheet — the heart of the collector view */}
      {specs.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em] text-gray-400">
            Specifications
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {specs.map((spec) => (
              <SpecField key={spec.label} {...spec} />
            ))}
          </div>
        </section>
      )}

      {/* Browse-only context + maker navigation */}
      <section className="mt-6 rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-5 py-5 text-center dark:border-gray-700 dark:bg-gray-900/50">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          This board is part of the <strong className="font-semibold text-gray-800 dark:text-gray-200">Showcase</strong> — a
          browse-only gallery of community builds. No tracking, no pricing.
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {maker && (
            <Link
              href={`/showcase?designer=${encodeURIComponent(maker)}`}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-violet-700"
            >
              More from {maker}
            </Link>
          )}
          <Link
            href="/showcase"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-bold text-gray-700 transition-colors hover:border-violet-300 hover:text-violet-700 dark:border-gray-700 dark:text-gray-200"
          >
            Browse the Showcase
          </Link>
        </div>
      </section>
    </div>
  );
}
