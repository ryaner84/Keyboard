import type { KeyboardDetails } from "@/lib/keyboard-details";

// Presents the structured facts pulled out of a keyboard group-buy description
// — timeline (dates), regional vendors, specs, and per-edition pricing — as
// scannable key info instead of one wall of prose. Server component: pure
// display, no client JS. Only the sections with data are rendered.

function Card({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="border-b border-gray-100 px-5 py-3.5 dark:border-gray-800">
        {eyebrow && (
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-400">
            {eyebrow}
          </p>
        )}
        <h2 className="text-base font-bold text-gray-900 dark:text-white">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

const CalendarIcon = (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path strokeLinecap="round" d="M3 9h18M8 3v4M16 3v4" />
  </svg>
);

export function KeyboardDetailsPanel({ details }: { details: KeyboardDetails }) {
  const { timeline, vendors, specs, editions } = details;

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Timeline — dates are what a collector checks first (deadline + ETA) */}
      {timeline.length > 0 && (
        <Card title="Group buy timeline" eyebrow="Dates">
          <ul className="space-y-2.5">
            {timeline.map((row) => (
              <li key={row.label} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300">
                  {CalendarIcon}
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400">
                    {row.label}
                  </p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">
                    {row.value}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Where to buy — the regional vendor list from the post */}
      {vendors.length > 0 && (
        <Card title="Where to buy" eyebrow="Vendors by region">
          <ul className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
            {vendors.map((v) => (
              <li
                key={`${v.region}-${v.name}`}
                className="flex items-center justify-between gap-2 border-b border-gray-50 py-1 last:border-0 dark:border-gray-800"
              >
                <span className="text-xs font-medium text-gray-400">{v.region}</span>
                <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                  {v.name}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Specs — the build sheet */}
      {specs.length > 0 && (
        <Card title="Specs" eyebrow="Build">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
            {specs.map((row) => (
              <div key={row.label} className="flex flex-col">
                <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400">
                  {row.label}
                </dt>
                <dd className="text-sm font-semibold text-gray-900 dark:text-white">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {/* Editions & pricing — colourway → price */}
      {editions.length > 0 && (
        <Card title="Editions & pricing" eyebrow="Colourways">
          <ul className="space-y-1.5">
            {editions.map((e) => (
              <li
                key={e.name}
                className="flex items-center justify-between gap-3 border-b border-gray-50 py-1.5 last:border-0 dark:border-gray-800"
              >
                <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                  {e.name}
                </span>
                <span className="shrink-0 rounded-md bg-emerald-50 px-2 py-0.5 text-sm font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  {e.price}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
