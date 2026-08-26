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

import { describeDeadListings } from "./link-health.mjs";

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
 *
 * `otherHostKeys` is the set of host keys that already belong to a DIFFERENT
 * vendor row (hostKey form, www-insensitive). A storeLink on one of those is
 * refused for the same reason a marketplace link is: it is a shop, but it is
 * not this shop. Adopting it parks the vendor on someone else's catalogue,
 * which discovery then crawls under this vendor's name — see
 * planStorefrontOwnership, which repairs the rows that reached that state
 * before this guard existed. One of Swagkeys (KR)'s 13 upstream entries names
 * mokbstore.com, so without this the deploy-time repair is undone by the very
 * next nightly import.
 *
 * `ownHostKey` is the host this vendor is KNOWN to own — see ownStorefrontHost
 * below: the roster's when it names one, otherwise the strict-plurality host of
 * the vendor's own listing URLs, which is the same evidence
 * planStorefrontRelocation settles the question with at deploy time.
 * A store that moved domains keeps upstream entries on the old one forever:
 * 96 of NovelKeys' 258 links are novelkeys.xyz, its retired site, and
 * last-write-wins is exactly how the Vendor row came to be registered there.
 * So once the row IS on the host its listings sell from, no storeLink may move
 * it off again — otherwise the deploy repairs it and that same night's import
 * puts it back, which is the loop #133 and #137 each had to close for their own
 * shape. When the row is NOT yet on that host, an incoming link is adopted only
 * if it names it, so the import converges on the store's real site instead of
 * wandering between its old ones. Omitted (a brand-new vendor, or one whose
 * listings name no storefront) leaves the rule above unchanged.
 *
 * @param {string | null | undefined} current
 * @param {string | null | undefined} incoming
 * @param {{ has(host: string): boolean }} [otherHostKeys]
 * @param {string | null | undefined} [ownHostKey]
 */
export function nextVendorWebsiteUrl(
  current,
  incoming,
  otherHostKeys = new Set(),
  ownHostKey = ""
) {
  const currentUrl = String(current ?? "").trim();
  let origin = "";
  try {
    const parsed = new URL(String(incoming ?? "").trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin;
  } catch {
    origin = "";
  }
  if (!origin || !isStorefrontHost(hostOfUrl(origin))) return currentUrl;
  const incomingKey = hostKey(hostOfUrl(origin));
  if (otherHostKeys?.has?.(incomingKey)) return currentUrl;
  const ownKey = hostKey(ownHostKey ?? "");
  if (ownKey && incomingKey !== ownKey) return currentUrl;
  return origin;
}

/**
 * Every spelling of a vendor slug the roster pins, mapped to the storefront it
 * pins it to. Aliases are included because the roster's slugs are not always
 * the database's (`cannonkeys`/`cannon-keys`, `thekeyco`/`the-key-company`, …).
 *
 * @param {Array<{ slug?: string, websiteUrl?: string, aliases?: string[] }>} roster
 * @returns {Map<string, string>} slug (and alias) -> the roster's websiteUrl
 */
export function rosterHostBySlug(roster) {
  const bySlug = new Map();
  for (const entry of roster ?? []) {
    const url = String(entry?.websiteUrl ?? "").trim();
    if (!entry?.slug || !hostOfUrl(url)) continue;
    for (const slug of [entry.slug, ...(entry.aliases ?? [])]) bySlug.set(slug, url);
  }
  return bySlug;
}

/**
 * The host a vendor is KNOWN to own — what `nextVendorWebsiteUrl` must be given
 * as `ownHostKey` so an import can never move the row off it.
 *
 * The listing plurality alone was the whole answer until it repaired one loop by
 * opening another. It works when the store's own links name the site it sells
 * from (NovelKeys: 162 novelkeys.com against 96 on the retired .xyz). It fails
 * exactly where the ROSTER exists to help — a store whose links are ALL on the
 * domain it left. Maamaadei is that case: its one listing is on
 * www.maamaadei.xyz, which no longer resolves, so the plurality names the dead
 * domain. The guard then reads backwards: an upstream `.xyz` storeLink matches
 * "its own host" and is adopted, while the `.com` one the roster names is
 * refused for not matching. Every deploy healed the row to maamaadei.com and the
 * next import was free to put it straight back — the store dark again, which is
 * the state #145 fixed by hand.
 *
 * The roster is the hand-written rung that is right by construction, so where it
 * names a storefront that IS the vendor's own host, and the listing plurality is
 * only consulted for the rows it doesn't name. A roster-pinned row is therefore
 * pinned in both directions: nothing can move it off, and planRosterSync is free
 * to move it on.
 *
 * @param {string | null | undefined} rosterUrl  the roster's websiteUrl, if any
 * @param {string[]} [listingUrls]               the vendor's own listing URLs
 * @returns {string | null}
 */
export function ownStorefrontHost(rosterUrl, listingUrls) {
  const pinned = hostOfUrl(String(rosterUrl ?? "").trim());
  if (pinned) return pinned;
  return storefrontHostFromUrls(listingUrls);
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
 * Resolve Vendor rows that are parked on a storefront belonging to a DIFFERENT
 * store.
 *
 * `needsStorefront` asks whether a URL is *a* shop. It cannot ask the question
 * that matters here — whether it is *this vendor's* shop — so a row carrying
 * another store's host reads as perfectly healthy and no repair ever revisits
 * it. Swagkeys (KR) shipped registered as `https://mokbstore.com`, which is
 * Mokb Store's site and Mokb Store's own row carries it too. That row is
 * uncrawlable *as itself*, and every downstream pass keys on the host:
 *
 *   - both discovery halves fetch `{websiteUrl}/products.json`, so Mokb's
 *     catalogue is linked as Swagkeys (KR) VendorKits, at Mokb's prices — the
 *     set page publishes one shop's listing twice, under two shop names, and
 *     one of them is wrong;
 *   - `find_vendor_for_url` resolves a URL to the FIRST Vendor row on that
 *     host, so which of the two a dcs.wiki group-buy page attaches to is
 *     whichever Postgres returns first;
 *   - the store's real site is never crawled, so its own listings are never
 *     relinked and it publishes nothing of its own — permanently.
 *
 * The evidence needed to fix it is already in the database: the row's own
 * VendorKit URLs name its real storefront (11 of Swagkeys (KR)'s 13 listings
 * are on www.swagkey.kr). So a host carried by two or more rows is settled by
 * asking whose listings agree with it, and the row that loses is repaired to
 * the storefront its own listings name.
 *
 * `vendors` is [{ id, slug, websiteUrl, listingUrls }] — every vendor, not
 * just the colliding ones, because a host is only contested relative to the
 * rest of the table. `roster` is the hand-written seed: a row whose storefront
 * the roster assigns wins its host outright, since the roster is the rung that
 * exists to be right about exactly this.
 *
 * Deliberately narrow: a row that does not share its host with another row is
 * never touched, and a collision nothing can settle is reported rather than
 * guessed at. Protozoa Studio and Protozoa Studio (US) both list on
 * protozoa.studio and both are telling the truth — that is two rows for one
 * shop, a merge no automatic pass should perform.
 *
 * Returns { heal, contested }, both pure:
 *   heal      — { ...vendor, host, current, websiteUrl } for a row moved off
 *               somebody else's storefront onto its own; `current` is what it
 *               was parked on, so the caller can guard its UPDATE
 *   contested  — rows sharing a host that the data cannot settle, each with the
 *               reason, for the build log
 */
export function planStorefrontOwnership(vendors, roster = []) {
  const pinnedBySlug = new Map();
  for (const entry of roster ?? []) {
    const key = hostKey(hostOfUrl(entry?.websiteUrl));
    if (!entry?.slug || !key) continue;
    for (const slug of [entry.slug, ...(entry.aliases ?? [])]) pinnedBySlug.set(slug, key);
  }

  // Only rows that HAVE a storefront can collide over one. The blank and
  // parked-on-a-shortener shapes are planVendorUrlHeal's business.
  const rows = (vendors ?? []).filter((v) => !needsStorefront(v.websiteUrl));
  const byHost = new Map();
  for (const row of rows) {
    const key = hostKey(hostOfUrl(row.websiteUrl));
    if (!key) continue;
    byHost.set(key, [...(byHost.get(key) ?? []), row]);
  }

  const heal = [];
  const contested = [];
  for (const [host, group] of byHost) {
    if (group.length < 2) continue;

    // The roster decides when it names one; otherwise the row whose own
    // listings sell from this host does.
    const pinned = group.filter((row) => pinnedBySlug.get(row.slug) === host);
    const claimants =
      pinned.length > 0
        ? pinned
        : group.filter(
            (row) => hostKey(storefrontHostFromUrls(row.listingUrls) ?? "") === host
          );
    if (claimants.length !== 1) {
      const reason =
        claimants.length === 0
          ? "no row's own listings sell from it"
          : "several rows' listings sell from it — one shop, two rows, merge them";
      for (const row of group) contested.push({ ...row, host, owner: null, reason });
      continue;
    }

    const owner = claimants[0];
    for (const row of group) {
      if (row === owner) continue;
      const own = storefrontHostFromUrls(row.listingUrls);
      const ownKey = hostKey(own ?? "");
      if (!ownKey || ownKey === host) {
        contested.push({
          ...row,
          host,
          owner: owner.slug,
          reason: own
            ? "its listings sell from the same host — one shop, two rows, merge them"
            : "its listings name no storefront of its own",
        });
        continue;
      }
      if (byHost.has(ownKey)) {
        contested.push({
          ...row,
          host,
          owner: owner.slug,
          reason: `its own storefront ${own} already belongs to ${byHost.get(ownKey)[0].slug}`,
        });
        continue;
      }
      byHost.set(ownKey, [row]); // one host, one row — including the repaired one
      heal.push({
        ...row,
        host: own,
        current: String(row.websiteUrl ?? "").trim(),
        websiteUrl: `https://${own}`,
      });
    }
  }
  return { heal, contested };
}

/**
 * Move a vendor off a storefront that is a real shop, is nobody else's, and is
 * still not the site this store sells from.
 *
 * planStorefrontOwnership can only ask "is this THIS shop?" when two rows fight
 * over one host — the collision is its whole evidence. A row parked ALONE on
 * the wrong site answers "healthy" to every existing repair: `needsStorefront`
 * says it is a shop, no other row contests it, and planVendorUrlHeal only ever
 * looks at rows `needsStorefront` flagged. Six of the 125 shipped vendors are
 * in that state and only one of them (Swagkeys (KR), which happens to share
 * mokbstore.com with Mokb Store's own row) was reachable by any of them:
 *
 *   novelkeys   novelkeys.xyz               → novelkeys.com               162:96
 *   omnitype    dixiemech.com               → omnitype.com                 42:6
 *   yushakobo   yushakobo.jp                → shop.yushakobo.jp            44:8
 *   mekanisk    mekanisktastatur.no         → tastatur.no                  14:2
 *   mechboards  mechboards.co.uk            → groupbuys.mechboards.co.uk    6:2
 *
 * A retired domain, a sibling brand, a corporate apex instead of the shop
 * subdomain (host matching folds "www." and nothing else, so shop.yushakobo.jp
 * is a different host from yushakobo.jp — which is why SEEDED_VENDORS in
 * scrape.py had to hard-code a repoint for that ONE store, in the Python half
 * only). Every rotation asks the wrong site for /products.json, so the store is
 * never crawled AS ITSELF: no new listing is ever linked, no moved listing is
 * ever relinked, and its dead URLs never heal — which on a RELEASED set means
 * hidden, because an unpriced row is not shown there. `find_vendor_for_url`
 * resolves outlet collections by host too, so none of them can reach the row
 * either. Worst of all is the shape with a live shop on the wrong side of it:
 * discovery reads DixieMech's catalogue and files it as Omnitype's listings —
 * planStorefrontOwnership's exact harm, with no collision to detect it.
 *
 * The evidence is already in the database, and it is the same evidence every
 * other planner here uses: the row's own VendorKit URLs. So the rule is the
 * same too — `storefrontHostFromUrls`, a STRICT plurality, ties left alone.
 * Deliberately narrow on top of that:
 *
 *   - a slug the roster pins is skipped outright; planRosterSync has already
 *     decided it and the roster is the rung that is right by construction;
 *   - a row sharing its host with another row is skipped: that is a contested
 *     host, which is planStorefrontOwnership's business and settled with
 *     different evidence;
 *   - a winning host another row already holds is REPORTED, never taken —
 *     adopting it is how a vendor gets parked on someone else's shop in the
 *     first place.
 *
 * `vendors` is [{ id, slug, websiteUrl, listingUrls }] — every vendor, since a
 * host is only "taken" relative to the rest of the table. `roster` is the
 * hand-written seed. Returns { heal, contested }, both pure; `heal` carries
 * `current` so the caller can guard its UPDATE on the value planned against.
 */
export function planStorefrontRelocation(vendors, roster = []) {
  const pinnedSlugs = new Set();
  for (const entry of roster ?? []) {
    if (!entry?.slug || !hostOfUrl(entry?.websiteUrl)) continue;
    for (const slug of [entry.slug, ...(entry.aliases ?? [])]) pinnedSlugs.add(slug);
  }

  // Only a row that HAS a storefront can be on the wrong one; blank and
  // shortener-parked rows are planVendorUrlHeal's shape.
  const rows = (vendors ?? []).filter((v) => v && !needsStorefront(v.websiteUrl));
  const holders = new Map(); // hostKey -> [slug]
  for (const row of rows) {
    const key = hostKey(hostOfUrl(row.websiteUrl));
    if (key) holders.set(key, [...(holders.get(key) ?? []), row.slug]);
  }

  const heal = [];
  const contested = [];
  for (const row of rows) {
    const current = String(row.websiteUrl ?? "").trim();
    const currentKey = hostKey(hostOfUrl(current));
    if (!currentKey || pinnedSlugs.has(row.slug)) continue;
    if ((holders.get(currentKey) ?? []).length > 1) continue;

    const own = storefrontHostFromUrls(row.listingUrls);
    const ownKey = hostKey(own ?? "");
    if (!ownKey || ownKey === currentKey) continue;

    const holder = (holders.get(ownKey) ?? []).find((slug) => slug !== row.slug);
    if (holder) {
      contested.push({
        ...row,
        host: own,
        owner: holder,
        reason: `its listings sell from ${own}, which already belongs to ${holder}`,
      });
      continue;
    }
    holders.set(ownKey, [row.slug]);
    holders.set(currentKey, []); // the row no longer holds the host it left
    heal.push({ ...row, host: own, current, websiteUrl: `https://${own}` });
  }
  return { heal, contested };
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
 * And it is right about a WRONG storefront too, which is the case this rung
 * spent a year declining to fix. `needsStorefront` asks whether a URL is *a*
 * shop, never whether it is *this* shop, so a row parked on a real-looking site
 * that is not the store's own reads as healthy and the heal skipped it —
 * `novelkeys` shipped as https://novelkeys.xyz, NovelKeys' retired domain,
 * while this very roster names https://novelkeys.com, and every deploy for a
 * year read the row, agreed it was "a shop", and left it. Discovery therefore
 * asked novelkeys.xyz for /products.json on every rotation, so one of the
 * biggest stores on the site could never be linked to a new listing nor have a
 * moved one relinked — and because `find_vendor_for_url` resolves an outlet
 * collection by HOST, all four of NovelKeys' OUTLET_COLLECTIONS entries (the
 * discounted-GMK and GMK-leftovers pages, which is where its in-stock sets
 * actually are) logged "no tracked vendor for novelkeys.com" and did nothing,
 * every night. `test:vendor-urls` did not catch that: it checks the outlet
 * hosts against the ROSTER, which was right — it was the Vendor row that
 * disagreed. Comparison is by HOST, so a www-only spelling difference
 * (`ashkeebs` is www.ashkeebs.com in the DB and ashkeebs.com in the roster)
 * is not churn worth writing.
 *
 * `existing` is [{ slug, websiteUrl }]. Returns, all pure:
 *   insert    — roster rows with no row under any of their slugs and no other
 *               vendor already owning their host
 *   heal      — { slug, websiteUrl, current } for a row this roster entry names
 *               whose storefront is missing, unusable, or on the wrong host;
 *               `current` is what it is being replaced with, so the caller can
 *               guard its UPDATE
 *   aliased   — roster rows a differently-slugged vendor already covers by host
 *   duplicate — extra rows matching the same roster entry: two Vendor rows for
 *               one shop. `planVendorMerges` below turns this list into the
 *               merge that folds them back into one row.
 *   conflicted — a row the roster would move onto a host ANOTHER vendor row
 *               already holds. Moving it would re-create exactly what
 *               planStorefrontOwnership exists to undo, so it is reported
 *               instead: two rows claiming one shop needs a person.
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
  const conflicted = [];
  for (const entry of roster ?? []) {
    const websiteUrl = String(entry?.websiteUrl ?? "").trim();
    if (!entry?.slug || !websiteUrl) continue;
    const rosterKey = hostKey(hostOfUrl(websiteUrl));

    // Declared order is the priority order: the canonical slug wins when both
    // spellings exist, so the heal never lands on the row we'd rather retire.
    const present = [entry.slug, ...(entry.aliases ?? [])].filter((s) => urlBySlug.has(s));
    if (present.length > 0) {
      const target = present[0];
      const current = urlBySlug.get(target);
      // Missing, unusable, or simply not this store's site — the roster is the
      // hand-written rung, so it outranks all three.
      const wrongHost = hostKey(hostOfUrl(current)) !== rosterKey;
      if (needsStorefront(current) || wrongHost) {
        const owner = ownerByHost.get(rosterKey);
        if (owner && owner !== target) {
          conflicted.push({ slug: target, owner, host: rosterKey });
        } else {
          heal.push({ slug: target, websiteUrl, current });
          // One host, one row — including the one this heal is about to create.
          if (rosterKey) ownerByHost.set(rosterKey, target);
        }
      }
      for (const extra of present.slice(1)) duplicate.push({ slug: extra, keeps: target });
      continue;
    }

    const owner = ownerByHost.get(rosterKey);
    if (owner) {
      aliased.push({ slug: entry.slug, owner });
      continue;
    }
    insert.push(entry);
    if (rosterKey) ownerByHost.set(rosterKey, entry.slug);
  }
  return { insert, heal, aliased, duplicate, conflicted };
}

/**
 * The duplicate Vendor rows `planRosterSync` reports, planned as merges.
 *
 * Aliases were added to stop the roster INSERTING a second row for a store the
 * database already knew under another spelling — and they do. They never
 * removed the rows the roster had already inserted, so five shops still carry
 * two Vendor rows each (cannonkeys/cannon-keys, thekeyco/the-key-company,
 * mykeyboard-eu/mykeyboard, mech-land/mechland, toro-studio/toro-studios) and
 * every deploy since has printed "merge or remove them" at a pass that cannot.
 *
 * Two rows for one shop is not a cosmetic duplicate. Discovery rotates
 * _DISCOVERY_VENDOR_LIMIT (8) stores a night across ~130 rows, so each ghost
 * spends a slot re-fetching a catalogue that was already crawled under the
 * other id — a real store loses its turn for a fortnight — and whichever id the
 * crawl happens to be running under is where the listings land.
 * `find_vendor_for_url` resolves by host and returns whichever of the two
 * Postgres hands back first, so an outlet collection can attach to either. The
 * split is visible in the audit: `the-key-company` holds 12 listings while
 * `thekeyco` holds 0, `mykeyboard` holds 206 while `mykeyboard-eu` holds 0.
 * The empty half publishes nothing, permanently, and is named for it.
 *
 * The survivor is the roster's own slug when a row carries it, because that is
 * the slug `planRosterSync` heals on every deploy — keeping the other one would
 * leave the roster repairing a row that no longer exists. Everything the drops
 * carry moves onto it first; the caller does the moving.
 *
 * This DELETES a Vendor row, so — exactly like `setMergeIdentity` — the bar is
 * higher than a display collapse and two guards keep it there:
 *
 *   * Only the ROSTER may declare two slugs to be one shop. It is the
 *     hand-written rung, right by construction. Rows that merely share a host
 *     (protozoa-studio / protozoa-studio-us, pancco / panc-interactive) are
 *     `planStorefrontOwnership`'s to report and nobody's to merge: regional
 *     storefronts sell different group buys from one site.
 *   * Every row that HAS a storefront must agree on the host. A blank or
 *     shortener-parked row (`needsStorefront`) contradicts nothing and merges —
 *     that is the stranded `cannon-keys` shape the aliases exist for — but two
 *     rows on two real, different shops are a stale alias, not a duplicate, and
 *     are reported rather than merged.
 *
 * `existing` is [{ slug, websiteUrl }]. Returns { merges, skipped }, both pure:
 *   merges  — { keep, drop: [...], host } of slugs, ready to fold together
 *   skipped — { slugs, hosts, reason } for an alias group that disagrees
 */
export function planVendorMerges(roster, existing) {
  const bySlug = new Map();
  for (const row of existing ?? []) {
    if (row?.slug) bySlug.set(row.slug, String(row.websiteUrl ?? "").trim());
  }

  const merges = [];
  const skipped = [];
  const claimed = new Set();
  for (const entry of roster ?? []) {
    if (!entry?.slug) continue;
    // Declared order is the priority order, same as planRosterSync: the
    // canonical slug survives whenever a row carries it.
    const present = [entry.slug, ...(entry.aliases ?? [])].filter((s) => bySlug.has(s));
    if (present.length < 2) continue;
    // One row can only be merged once. Two roster entries naming the same
    // alias is a roster bug; acting on both would delete a row twice.
    if (present.some((slug) => claimed.has(slug))) continue;

    const hosts = present
      .map((slug) => ({ slug, url: bySlug.get(slug) }))
      .filter((row) => !needsStorefront(row.url))
      .map((row) => ({ slug: row.slug, key: hostKey(hostOfUrl(row.url)) }));
    const distinct = new Set(hosts.map((h) => h.key));
    if (distinct.size > 1) {
      skipped.push({
        slugs: present,
        hosts: [...distinct].sort(),
        reason: "the rows sit on different storefronts — a stale alias, not a duplicate",
      });
      continue;
    }

    for (const slug of present) claimed.add(slug);
    merges.push({
      keep: present[0],
      drop: present.slice(1),
      host: hosts[0]?.key ?? hostKey(hostOfUrl(entry.websiteUrl)) ?? "",
    });
  }
  return { merges, skipped };
}

/**
 * Vendors that publish nothing on the site despite having a healthy storefront.
 *
 * The storefront chain above (planRosterSync → planStorefrontOwnership →
 * planVendorUrlHeal) exists because a Vendor row with no usable `websiteUrl`
 * publishes nothing at all: discovery can't crawl it, run_outlets can't resolve
 * a collection to it, and its URL-less listings can never be priced. Every step
 * of that chain repairs a shape the DATA lets us repair — a blank or
 * shortener-parked URL, a row on another shop's host — and names the residue
 * (`stranded`, `contested`, "not shops") so the owner can act on the rest.
 *
 * There is a further shape those repairs cannot see — the fifth, after a blank
 * URL, a non-shop URL, another store's storefront, and (planStorefrontRelocation
 * above) a storefront that is nobody else's and still not this store's. A
 * vendor can carry a real storefront, its OWN, and still publish nothing on any
 * set page — because its catalog
 * pass never matched a tracked set, or its /products.json turned to a redirect,
 * or its every scraped price landed at null and the sets it lists are all
 * RELEASED (which hides unpriced rows). The row LOOKS healthy to every planner
 * above; the site just never shows anything from it.
 *
 * A visible listing is a VendorKit whose kit is a BASE and that either has a
 * price (rendered as a priced row on any set) or has a store link on an ACTIVE
 * GB (rendered as an unpriced link — released sets suppress those). The caller
 * counts those in SQL — this planner has no DB — and passes each vendor's
 * `visibleListings`. A vendor with zero of them AND a healthy storefront
 * (`!needsStorefront`) is one the site never surfaces on any set page.
 *
 * `excludeSlugs` skips the vendor rows that are catalog markers (gmk, dcs-wiki)
 * or that this deploy is about to purge (blocked vendors). Passed in rather
 * than named here to keep this file free of the manufacturer registry, which
 * is TypeScript.
 *
 * Each vendor is also given a REASON, because "one of three things went wrong"
 * is not a diagnosis — it named the vendor and then left the owner to work out
 * which pass to look at. The three causes leave different residue in the DB and
 * the counts separate them cleanly:
 *
 *   deadListings > 0             the STORE answered 404/410 for those pages.
 *                                Checked first, because a 404 counts as a READ
 *                                as far as `priceSource` goes and would
 *                                otherwise be reported as the pricing backlog
 *                                below — which is what happened to nearly every
 *                                silent store until the price pass learned to
 *                                record it (see scripts/lib/link-health.mjs).
 *   listings = 0                 discovery has never linked this store to a
 *                                tracked set. The catalog pass is the one to
 *                                look at — a store whose catalogue is entirely
 *                                profiles the tracked-profile gate refused
 *                                lands here, which is exactly how every
 *                                Signature Plastics specialist read as healthy
 *                                while publishing nothing.
 *   listings > 0, read = 0       the price pass has never once READ one of this
 *                                store's pages — see below. Its links are dead;
 *                                relink or retire the store.
 *   listings > 0, priced = 0     read, and the answer was "nothing priced here".
 *                                Unpriced rows are hidden outright on RELEASED
 *                                sets, which is where most listings live — so
 *                                the store has rows and still shows nothing.
 *                                refresh-prices.
 *   priced > 0, visible = 0      priced, but every row is filtered off the set
 *                                page: a non-BASE kit, or a catalog URL that
 *                                PURCHASABLE_VENDOR_KIT_WHERE refuses.
 *
 * The read/never-read split is the one that had the owner chasing the wrong
 * pass. "None priced — refresh-prices" was said about every silent store, and
 * for most of them refresh-prices had already read the URL every six hours for
 * months and can never succeed: the store closed (kono.store), moved domain
 * (apexkeyboards.ca → .com), was acquired (ashkeebs.com now serves
 * kineticlabs.com), turned on a Shopify password page (hexkeyboards.com) or let
 * its plan lapse (402). None of those is a 404, and only a 404/410 clears a
 * price — so the row is retried forever, stays unpriced, stays hidden, and the
 * report keeps naming the one pass that cannot help.
 *
 * `priceSource` is the evidence, and it is already in the table: the price pass
 * writes 'SCRAPED' whenever it READ the page, including when the answer was "no
 * base kit on offer" (price NULL). A row whose `priceUpdatedAt` is set while
 * `priceSource` is still NULL was attempted and never once parsed. A vendor
 * where that is true of EVERY row has a dead link set, not a pricing backlog.
 *
 * `listings` counts the vendor's VendorKit rows of ANY kit type,
 * `readListings` the ones the price pass has ever read (priceSource not null)
 * and `pricedListings` the ones carrying a price, so the four cases stay
 * disjoint; `visibleListings` is the narrow site-visible count described above.
 * All are counted in SQL by the caller — this planner has no DB.
 *
 * @param {Array<{ slug: string, websiteUrl?: string | null, visibleListings?: number,
 *                 listings?: number, readListings?: number,
 *                 pricedListings?: number }>} vendors
 * @param {Set<string>} [excludeSlugs]
 */
export function planPublishingReport(vendors, excludeSlugs = new Set()) {
  return (vendors ?? [])
    .filter((v) => v && v.slug && !excludeSlugs.has(v.slug))
    // Blank / shortener / marketplace rows and rows parked on another shop's
    // host are already named by the storefront chain — reporting them here too
    // would just double the noise on the deploy log.
    .filter((v) => !needsStorefront(v.websiteUrl))
    .filter((v) => Number(v.visibleListings ?? 0) === 0)
    .map((v) => ({
      slug: v.slug,
      websiteUrl: String(v.websiteUrl ?? "").trim(),
      reason: publishingFailureReason(v),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Which pass to look at for a vendor the site never surfaces. */
function publishingFailureReason(vendor) {
  const listings = Number(vendor.listings ?? 0);
  const priced = Number(vendor.pricedListings ?? 0);
  // The store itself said the pages are gone (404/410). That outranks every
  // reason below, including "read but not priced": a 404 IS a read as far as
  // priceSource is concerned, which is exactly how monokei, vala-supply,
  // mechs-co and apex-keyboards were all reported as a pricing backlog while
  // every one of their sampled product pages had in fact been removed.
  const deadReason = describeDeadListings(
    listings,
    vendor.deadListings,
    vendor.deadestSince
  );
  if (deadReason) return deadReason;
  // Absent means "not measured", NOT zero. Every other count here defaults to 0
  // and a caller that forgets one gets a confident wrong diagnosis for free —
  // the mistake this reason exists to stop. Defaulting to `listings` degrades to
  // the pre-existing message instead; test:vendor-urls asserts db-setup passes it.
  const read = vendor.readListings == null ? listings : Number(vendor.readListings);
  if (!(listings > 0)) return "no listing linked — discovery has never matched a tracked set";
  // Never once parsed, however many times it was fetched: the links are dead
  // (store closed, moved domain, password page, plan lapsed). refresh-prices
  // cannot end this — relinking or retiring the store can. Only claimed when a
  // price is absent too, so a store that reads fine keeps the priced reasons.
  if (!(priced > 0) && !(read > 0)) {
    return (
      `${listings} listing(s) linked, the price pass has never read one — ` +
      `the store's links are dead; relink or retire it`
    );
  }
  if (!(priced > 0)) {
    return `${listings} listing(s) linked, none priced — unpriced rows are hidden on released sets`;
  }
  return `${priced} of ${listings} listing(s) priced but none visible — non-BASE kit or catalog URL`;
}

/** Why no storefront could be derived — reported so the log is actionable. */
function reasonForNoHost(urls) {
  const hosts = (urls ?? []).map(hostOfUrl).filter(Boolean);
  if (hosts.length === 0) return "no listing carries a URL either";
  if (!hosts.some(isStorefrontHost)) return "links are marketplace/forum pages only";
  return "listing URLs disagree on the storefront";
}
