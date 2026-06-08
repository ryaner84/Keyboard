/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.cloudinary.com" },
      { protocol: "https", hostname: "cdn.shopify.com" },
    ],
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
