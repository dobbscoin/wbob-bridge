/** @type {import('next').NextConfig} */
const nextConfig = {
  // Silence RainbowKit/wagmi server-side import warnings
  webpack: (config) => {
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
};

export default nextConfig;
