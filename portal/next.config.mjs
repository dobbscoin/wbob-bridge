/** @type {import('next').NextConfig} */
const nextConfig = {
  // Silence RainbowKit/wagmi server-side import warnings
  webpack: (config) => {
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
  async redirects() {
    return [
      // /test → / (Bridge & Fuel was promoted from test bed to home page)
      { source: '/test',       destination: '/',      permanent: true },
      { source: '/test/trade', destination: '/trade', permanent: true },
    ];
  },
};

export default nextConfig;
