// Recovering a vendor's storefront from the listings it already has.
//
// A Vendor row whose "websiteUrl" is blank can never be crawled: discovery
// builds `{websiteUrl}/products.json`, so a blank one is skipped on every pass
// (and since #131 it is excluded from the query outright). The store is then
// frozen in whatever state its last import left it — and for a vendor whose
// VendorKit rows carry no product URL either, that state is invisible: the
// price pass skips URL-less rows, so the price stays NULL, and VendorTable
// renders neither a priced row (needs price) nor an "unpriced" store link
// (needs gbUrl or productUrl). The store publishes nothing, forever.
//
// The roster (src/data/seed/vendors.json) repairs the ones it knows — 17
// stores. For the rest the answer is already in the database: their own
// VendorKit URLs name the storefront. basekeys' 34 listing URLs all point at
// basekeys.jp; Mekibo's at mekibo.com. Deriving the host from those makes the
// store crawlable again without anyone having to look a URL up by hand.

// Hosts that appear in listing URLs but are NOT a store's own storefront.
// Adopting one would point discovery at a marketplace, a forum thread or a
// link shortener, where /products.json is a 404 — which costs a rotation slot
// every few days and never produces a listing. A vendor whose only links are
// these is better reported as having no storefront than pointed at Taobao.
//
// Exported because the same list decides who enters the discovery rotation,
// in both halves of it: `_NON_STOREFRONT_HOSTS` in scraper/scrape.py is the
// Python copy and vendor-urls.test.mjs fails if the two disagree.
export const NON_STOREFRONT_HOSTS = [
  // Link shorteners and file/doc hosts (a GB spreadsheet is not a shop)
  "goo.gl", "bit.ly", "t.co", "tinyurl.com", "linktr.ee",
  "google.com", "docs.google.com", "drive.google.com", "forms.gle",
  // Image and static-page hosts. KeycapLendar files Drop listings under
  // imgur.com and matrixzj.github.io — an album and a docs site, neither of
  // which is Drop's shop.
  "imgur.com", "github.io", "github.com",
  // Social and community platforms
  "instagram.com", "facebook.com", "twitter.com", "x.com", "reddit.com",
  "discord.com", "discord.gg", "discord.link", "youtube.com",
  "notion.so", "notion.site",
  // Keyboard forums — a thread is a listing, not a catalogue
  "geekhack.org", "deskthority.net",
  // Marketplaces: the seller has a shop page, but the site is not theirs and
  // has no Shopify catalogue endpoint.
  "taobao.com", "tmall.com", "aliexpress.com", "alibaba.com", "1688.com",
  "etsy.com", "ebay.com", "amazon.com", "shopee.com", "lazada.com",
  "mercari.com", "kickstarter.com", "indiegogo.com",
  // Naver's marketplace, not the seller's own site: GEONWORKS and Swagkeys are
  // both filed under it upstream while running geon.works and swagkeys.com.
  "smartstore.naver.com",
];

/** Host of a URL, lowercased, or "" when it isn't an http(s) URL. */
export function hostOfUrl(url) {
  try {
    const parsed = new URL(String(url ?? "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Identity key for a host: "www.mekibo.com" and "mekibo.com" are one store.
 * Only the leading "www." is dropped — "en.zfrontier.com" and
 * "www.zfrontier.com" are two different sites (see ZFrontierStorefrontTests),
 * so no other subdomain is folded away.
 */
export function hostKey(host) {
  return String(host ?? "").toLowerCase().replace(/^www\./, "");
}

/** True when the host is a store's own site rather than a marketplace/forum. */
export function isStorefrontHost(host) {
  const key = hostKey(host);
  if (!key || !key.includes(".")) return false;
  return !NON_STOREFRONT_HOSTS.some(
    (blocked) => key === blocked || key.endsWith(`.${blocked}`)
  );
}

/**
 * True when a Vendor row's stored `websiteUrl` cannot serve as a storefront —
 * the one predicate every storefront repair should be keyed on.
 *
 * Blank is only HALF of that failure. `nextVendorWebsiteUrl` refuses to write
 * a marketplace/forum/shortener link over a storefront, but it can only guard
 * writes made after it existed: rows an earlier import downgraded (iLumKB has
 * upstream entries on item.taobao.com, NovelKeys on geekhack.org, Drop on
 * imgur.com) and rows that shipped that way in supabase-setup.sql (two vendors
 * registered as `https://goo.gl`, one as Instagram, one as a Google Doc) are
 * still sitting there. They are exactly as uncrawlable as a blank row —
 * `{websiteUrl}/products.json` 404s on goo.gl forever, `find_vendor_for_url`
 * matches no outlet collection to them, and their listings can never be
 * priced, which on a released set means hidden — but because they are NOT
 * blank, every repair keyed on `websiteUrl = ''` skipped them and the store
 * published nothing, permanently.
 */
export function needsStorefront(websiteUrl) {
  const url = String(websiteUrl ?? "").trim();
  if (!url) return true;
  return !isStorefrontHost(hostOfUrl(url));
}

/**
 * The storefront a set of listing URLs agrees on, or null.
 *
 * Hosts are counted by identity key (www-insensitive) and the winner must be a
 * STRICT plurality: Maamaadei's two links are one maamaadei.xyz and one
 * maamaadei.com, and picking either would be a coin toss stored as fact. The
 * literal spelling returned is the most common one seen for the winning key,
 * so a store that only ever serves www. keeps its www.
 */
export function storefrontHostFromUrls(urls) {
  const byKey = new Map(); // key -> { total, spellings: Map<host, count> }
  for (const url of urls ?? []) {
    const host = hostOfUrl(url);
    if (!host || !isStorefrontHost(host)) continue;
    const key = hostKey(host);
    const entry = byKey.get(key) ?? { total: 0, spellings: new Map() };
    entry.total += 1;
    entry.spellings.set(host, (entry.spellings.get(host) ?? 0) + 1);
    byKey.set(key, entry);
  }
  if (byKey.size === 0) return null;

  const ranked = [...byKey.entries()].sort((a, b) => b[1].total - a[1].total);
  if (ranked.length > 1 && ranked[0][1].total === ranked[1][1].total) return null;

  const [, winner] = ranked[0];
  return [...winner.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * The websiteUrl a vendor should be left with after a catalog import offers
 * `incoming` as that vendor's store link.
 *
 * The upstream catalog (KeycapLendar) records a storeLink PER SET, not per
 * store, so one shop is described 300 times over and the entries disagree:
 * 1228 of its 9031 vendor entries carry no storeLink at all, and 142 stores
 * have both linked and blank entries. A plain last-write-wins overwrite
 * therefore erases a working storefront whenever a blank entry happens to be
 * imported last — 79 of the 112 crawlable vendors are one nightly run away
 * from that, iLumKB and CannonKeys included. A blanked vendor is excluded from
 * discovery, so it gets no fresh VendorKit, the price pass skips its URL-less
 * rows, and the store publishes nothing at all until the next deploy heals it.
 *
 * The same overwrite can DOWNGRADE rather than erase: iLumKB has entries
 * pointing at item.taobao.com, NovelKeys at geekhack.org, Drop at imgur.com.
 * Those are real places that listing lives, and they stay on the VendorKit —
 * but as a storefront they are worse than nothing, because /products.json 404s
 * there forever AND the row is no longer blank, so no heal ever revisits it.
 *
 * So an import may only ever REPLACE a storefront with another storefront.
 * Blank, unparseable, and marketplace/forum/shortener links leave what's
 * already there alone; on a brand-new vendor they leave it blank, which is the
 * state planVendorUrlHeal above can still recover from.
 */
export function nextVendorWebsiteUrl(current, incoming) {
  const currentUrl = String(current ?? "").trim();
  let origin = "";
  try {
    const parsed = new URL(String(incoming ?? "").trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin;
  } catch {
    origin = "";
  }
  if (!origin || !isStorefrontHost(hostOfUrl(origin))) return currentUrl;
  return origin;
}

/**
 * Decide what to do with every vendor that has no usable storefront.
 *
 * `vendors` is [{ id, slug, websiteUrl?, listingUrls: string[] }] — rows whose
 * `websiteUrl` is blank OR isn't a shop (see needsStorefront; a row parked on
 * goo.gl is no more crawlable than a blank one, and until this planner took
 * both shapes it was the only one nothing ever revisited). `takenHostKeys` is
 * the set of host keys already registered to a vendor that HAS a real
 * storefront — a host may only belong to one Vendor row, so a vendor whose
 * listings point at an existing store is a duplicate of that store, not a new
 * one, and gets reported rather than silently pointed at the same catalogue
 * (which would then be crawled twice and publish the same listing under two
 * names).
 *
 * Returns { heal, duplicate, stranded } — pure, so the callers' SQL stays
 * dumb and this stays testable. Each entry carries the vendor's own fields
 * through, so a caller can guard its UPDATE on the `websiteUrl` it planned
 * against and say in the log what was replaced.
 */
export function planVendorUrlHeal(vendors, takenHostKeys = new Set()) {
  const heal = [];
  const duplicate = [];
  const stranded = [];
  for (const vendor of vendors ?? []) {
    // Defensive: a caller that widened its selection must not overwrite a
    // storefront that is already fine.
    if (!needsStorefront(vendor.websiteUrl)) continue;
    const host = storefrontHostFromUrls(vendor.listingUrls);
    if (!host) {
      stranded.push({ ...vendor, reason: reasonForNoHost(vendor.listingUrls) });
      continue;
    }
    const key = hostKey(host);
    if (takenHostKeys.has(key)) {
      duplicate.push({ ...vendor, host });
      continue;
    }
    // `websiteUrl` is the repaired value, so the one being replaced is kept
    // separately — a caller guarding its UPDATE on it needs both.
    heal.push({
      ...vendor,
      host,
      current: String(vendor.websiteUrl ?? "").trim(),
      websiteUrl: `https://${host}`,
    });
    // One host, one vendor — a later blank vendor pointing here is a duplicate
    // of this one, not a second store.
    takenHostKeys.add(key);
  }
  return { heal, duplicate, stranded };
}

/**
 * Reconcile the hand-written roster (src/data/seed/vendors.json) with the
 * Vendor rows that exist.
 *
 * The roster is the LAST rung of the storefront ladder. Above it,
 * `nextVendorWebsiteUrl` refuses to adopt a marketplace link and
 * `planVendorUrlHeal` refuses to derive a storefront from listings that are
 * marketplace-only — both correct, and both leave the same residue: a store
 * whose upstream entries only ever name a marketplace keeps a BLANK
 * websiteUrl forever. GEONWORKS (geon.works) and Swagkeys (swagkeys.com) are
 * filed under smartstore.naver.com by KeycapLendar and are exactly that case.
 * Blank means uncrawlable (both discovery halves exclude it), invisible to
 * run_outlets (which resolves a collection's vendor by HOST), and unpriceable
 * (its listings point at the marketplace) — so the store publishes nothing at
 * all. Only a hand-written entry can break the cycle.
 *
 * Matching by slug alone is not enough to do that, because the roster's slugs
 * are not always the database's: `cannonkeys`/`cannon-keys`,
 * `thekeyco`/`the-key-company`, … A store that already HAS a websiteUrl is
 * recognised by host (one store, one Vendor row), but the rows this function
 * exists to repair have no host to match on — so a blank row spelled
 * differently would be missed and the INSERT would create a SECOND row for
 * the same shop, leaving the original stranded. `aliases` names those
 * spellings explicitly rather than guessing at them.
 *
 * The roster repairs BOTH shapes of a missing storefront, not just the blank
 * one: a row an import downgraded to item.taobao.com or geekhack.org is as
 * uncrawlable as a blank row, and it is the shape nothing else revisits (see
 * needsStorefront). The roster is hand-written, so when it names a store the
 * database has parked on a marketplace, the roster is simply right.
 *
 * `existing` is [{ slug, websiteUrl }]. Returns, all pure:
 *   insert    — roster rows with no row under any of their slugs and no other
 *               vendor already owning their host
 *   heal      — { slug, websiteUrl, current } for a row this roster entry
 *               names that has no usable storefront; `current` is what it is
 *               being replaced with, so the caller can guard its UPDATE
 *   aliased   — roster rows a differently-slugged vendor already covers by host
 *   duplicate — extra rows matching the same roster entry: two Vendor rows for
 *               one shop, which is a merge nobody can do automatically
 */
export function planRosterSync(roster, existing) {
  const urlBySlug = new Map();
  for (const row of existing ?? []) {
    if (row?.slug) urlBySlug.set(row.slug, String(row.websiteUrl ?? "").trim());
  }
  // Hosts already spoken for by a vendor that has a storefront. A row parked
  // on a shortener owns nothing — counting goo.gl as "taken" would make the
  // roster treat a store it is trying to repair as somebody else's shop.
  const ownerByHost = new Map();
  for (const row of existing ?? []) {
    if (needsStorefront(row?.websiteUrl)) continue;
    const key = hostKey(hostOfUrl(row?.websiteUrl));
    if (key && !ownerByHost.has(key)) ownerByHost.set(key, row.slug);
  }

  const insert = [];
  const heal = [];
  const aliased = [];
  const duplicate = [];
  for (const entry of roster ?? []) {
    const websiteUrl = String(entry?.websiteUrl ?? "").trim();
    if (!entry?.slug || !websiteUrl) continue;

    // Declared order is the priority order: the canonical slug wins when both
    // spellings exist, so the heal never lands on the row we'd rather retire.
    const present = [entry.slug, ...(entry.aliases ?? [])].filter((s) => urlBySlug.has(s));
    if (present.length > 0) {
      const target = present[0];
      const current = urlBySlug.get(target);
      if (needsStorefront(current)) heal.push({ slug: target, websiteUrl, current });
      for (const extra of present.slice(1)) duplicate.push({ slug: extra, keeps: target });
      continue;
    }

    const key = hostKey(hostOfUrl(websiteUrl));
    const owner = ownerByHost.get(key);
    if (owner) {
      aliased.push({ slug: entry.slug, owner });
      continue;
    }
    insert.push(entry);
    if (key) ownerByHost.set(key, entry.slug);
  }
  return { insert, heal, aliased, duplicate };
}

/** Why no storefront could be derived — reported so the log is actionable. */
function reasonForNoHost(urls) {
  const hosts = (urls ?? []).map(hostOfUrl).filter(Boolean);
  if (hosts.length === 0) return "no listing carries a URL either";
  if (!hosts.some(isStorefrontHost)) return "links are marketplace/forum pages only";
  return "listing URLs disagree on the storefront";
}
