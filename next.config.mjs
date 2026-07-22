/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // Surfaced in the footer so we can tell which commit is live.
    // Vercel provides these system env vars at build time.
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || "",
    NEXT_PUBLIC_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF || "",
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || "",
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  images: {
    // Hotlink images directly from their source (KeycapLendar / vendor CDNs)
    // instead of downloading, optimizing, and caching them through Vercel.
    // This avoids Vercel's image-optimization quota and stores nothing — the
    // <Image> tags render a plain <img> pointing at the remote URL.
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.cloudinary.com" },
      { protocol: "https", hostname: "cdn.shopify.com" },
      // KeycapLendar set renders are served from Firebase storage.
      { protocol: "https", hostname: "firebasestorage.googleapis.com" },
    ],
  },
  async headers() {
    return [
      {
        // A "same-origin" referrer policy makes the browser omit the Referer on
        // cross-origin requests — required for hotlink-protected image hosts
        // (img.zfrontier.com returns 403 when a Referer is present, breaking
        // several GMK group-buy thumbnails). Unlike the <meta> tag, an HTTP
        // response header applies to the whole document from the start, so it
        // also governs the early <link rel="preload"> for priority carousel
        // images (the meta tag is parsed *after* that preload fires). Same-origin
        // referers stay intact for our own routes.
        source: "/(.*)",
        headers: [{ key: "Referrer-Policy", value: "same-origin" }],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Don't bundle Node.js-only packages for the browser
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        dns: false,
        pg: false,
        "pg-native": false,
      };
    }
    return config;
  },
};

export default nextConfig;
