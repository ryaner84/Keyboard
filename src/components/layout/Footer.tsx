export function Footer() {
  return (
    <footer className="border-t border-gray-100 bg-white mt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs">⌨</span>
            </div>
            <span className="font-bold text-gray-900">GMK Tracker</span>
          </div>
          <p className="text-sm text-gray-400 text-center">
            Community price tracker for GMK keycap group buys. Not affiliated with GMK or any vendor.
          </p>
          <div className="flex gap-4 text-sm text-gray-400">
            <a href="/browse" className="hover:text-gray-600 transition-colors">Browse</a>
            <a href="/tracker" className="hover:text-gray-600 transition-colors">Tracker</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
