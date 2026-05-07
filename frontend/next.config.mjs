/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
