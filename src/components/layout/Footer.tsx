function VersionStamp() {
  const sha = process.env.NEXT_PUBLIC_COMMIT_SHA || "";
  const ref = process.env.NEXT_PUBLIC_COMMIT_REF || "";
  const env = process.env.NEXT_PUBLIC_VERCEL_ENV || "local";
  const buildTime = process.env.NEXT_PUBLIC_BUILD_TIME || "";

  const short = sha ? sha.slice(0, 7) : "dev";
  const built = buildTime ? new Date(buildTime).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  const label = `${env} · ${ref || "local"} @ ${short}${built ? " · built " + built : ""}`;

  const inner = (
    <span className="font-mono">{label}</span>
  );

  return (
    <p className="text-[11px] text-gray-300 dark:text-gray-600 text-center mt-6">
      {sha ? (
        <a
          href={`https://github.com/ryaner84/Keyboard/commit/${sha}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-500 transition-colors"
        >
          {inner}
        </a>
      ) : (
        inner
      )}
    </p>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 mt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs">⌨</span>
            </div>
            <span className="font-bold text-gray-900 dark:text-white">GMK Tracker</span>
          </div>
          <p className="text-sm text-gray-400 text-center">
            Community price tracker for GMK keycap group buys. Not affiliated with GMK or any vendor.
          </p>
          <div className="flex gap-4 text-sm text-gray-400">
            <a href="/browse" className="hover:text-gray-600 transition-colors">Browse</a>
            <a href="/tracker" className="hover:text-gray-600 transition-colors">Tracker</a>
          </div>
        </div>
        <VersionStamp />
      </div>
    </footer>
  );
}
