// Best-effort gallery scraper for gmk.net product pages. GMK's official shop
// carries renders of every kit in a set (base, novelties, spacebars, etc.),
// which KeycapLendar does not. We extract those image URLs to power the set
// carousel.
//
// IMPORTANT: gmk.net bot-protects its pages and may return 403 to automated
// requests. This is therefore a best-effort enhancement — on failure we return
// an empty list and the caller keeps the single KeycapLendar render.

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_TIMEOUT_MS = 8000;

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Shopware renders "related products" / "customers also bought" carousels at the
// bottom of a product page, each carrying its own /media/ images. Those belong to
// OTHER sets and must not leak into this set's gallery. Cut the HTML at the first
// cross-selling / related-products marker so only the main product gallery remains.
function trimToMainGallery(html: string): string {
  const markers = [
    "cross-selling",
    "cross-sell",
    "cms-element-product-slider",
    "product-slider",
    "js-cross-selling",
    "Related products",
    "Customers also",
    "You may also",
  ];
  let cut = html.length;
  for (const marker of markers) {
    const idx = html.search(new RegExp(marker, "i"));
    if (idx !== -1 && idx < cut) cut = idx;
  }
  return html.slice(0, cut);
}

// Pull product image URLs out of a gmk.net product page. The shop (Shopware)
// serves media under /media/... — we collect unique image URLs in DOM order.
export function extractGmkImages(html: string): string[] {
  const urls = new Set<string>();

  // Only scan the main product gallery, not the related-products carousels.
  const scope = trimToMainGallery(html);

  // Match src / data-src / srcset / og:image referencing image files.
  const re = /(?:src|data-src|data-zoom-image|content)\s*=\s*["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    let u = m[1];
    if (u.startsWith("//")) u = "https:" + u;
    if (!/^https?:\/\//.test(u)) continue;
    // Keep only product media; drop logos, icons, payment badges, thumbnails.
    if (!/\/media\//.test(u)) continue;
    if (/(logo|icon|sprite|payment|flag|placeholder)/i.test(u)) continue;
    urls.add(u);
  }

  return Array.from(urls);
}

// Given a gmk.net product URL, return its gallery image URLs (best-effort).
export async function fetchGmkGallery(productUrl: string): Promise<string[]> {
  if (!/gmk\.net/i.test(productUrl)) return [];
  const html = await fetchHtml(productUrl);
  if (!html) return [];
  return extractGmkImages(html);
}
