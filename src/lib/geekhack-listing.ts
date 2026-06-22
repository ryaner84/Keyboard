const ENDED_OR_POST_GB =
  /\b(?:finished|gb\s+over|group\s+buy\s+over|ended|closed|completed|fulfilled|final\s+numbers|production\s+confirmed|in\s+(?:the\s+)?queue\s+for\s+production|in\s+production|replacement\s+keys?\s+shipped|delivering|delivered|shipping|last\s+day|final\s+weekend|100%\s+(?:sent|shipped|completed))\b/i;

const IN_STOCK =
  /\b(?:in[\s-]?stock|extras?\s+(?:are\s+)?(?:in\s+stock|available\s+now))\b/i;

const ACTIVE_SIGNAL =
  /\b(?:group\s+buy\s+live|gb\s+live|live\s+(?:now|until|through|thru|from)|orders?\s+(?:are\s+)?open|pre[\s-]?orders?\s+(?:are\s+)?(?:open|available)|group\s+buying\s+and\s+pre[\s-]?orders?\s+are\s+now\s+available)\b/i;

const MONTH_NAMES = [
  ["jan", "january"],
  ["feb", "february"],
  ["mar", "march"],
  ["apr", "april"],
  ["may"],
  ["jun", "june"],
  ["jul", "july"],
  ["aug", "august"],
  ["sep", "sept", "september"],
  ["oct", "october"],
  ["nov", "november"],
  ["dec", "december"],
];

export function isCrediblyActiveGeekhackListing(
  listing: {
    slug: string;
    name: string;
    status: string;
    gbEnd?: Date | string | null;
  },
  now = new Date()
): boolean {
  if (!listing.slug.startsWith("gh-") || listing.status !== "ACTIVE_GB") {
    return true;
  }

  const title = listing.name;
  if (IN_STOCK.test(title) || ENDED_OR_POST_GB.test(title)) return false;

  if (listing.gbEnd) {
    const end = new Date(listing.gbEnd);
    if (!Number.isNaN(end.getTime())) {
      return end.getTime() >= startOfToday(now).getTime();
    }
  }

  const explicitYears = Array.from(title.matchAll(/\b(20\d{2})\b/g)).map(
    (match) => Number(match[1])
  );
  if (explicitYears.length > 0 && Math.max(...explicitYears) < now.getFullYear()) {
    return false;
  }

  const currentMonth = MONTH_NAMES[now.getMonth()];
  const nextMonth = MONTH_NAMES[(now.getMonth() + 1) % 12];
  const mentionsCurrentWindow = [...currentMonth, ...nextMonth].some((month) =>
    new RegExp(`\\b${month}\\b`, "i").test(title)
  );

  return mentionsCurrentWindow || ACTIVE_SIGNAL.test(title);
}

function startOfToday(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
