// Resolves the site's public base URL for absolute links (og:image, QR codes,
// share links). Priority:
//   1. NEXT_PUBLIC_SITE_URL  — explicit override (custom domain)
//   2. VERCEL_PROJECT_PRODUCTION_URL — auto-injected by Vercel, stable prod domain
//   3. VERCEL_URL            — per-deployment URL (previews)
//   4. localhost             — local dev
export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit && !/localhost|127\.0\.0\.1/.test(explicit)) return explicit.replace(/\/$/, "");

  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}`;

  const deployment = process.env.VERCEL_URL;
  if (deployment) return `https://${deployment}`;

  return explicit?.replace(/\/$/, "") ?? "http://localhost:3000";
}
