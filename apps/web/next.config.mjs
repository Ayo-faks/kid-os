/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@careos/ui', '@careos/contracts'],
  typedRoutes: true,
};

export default nextConfig;
