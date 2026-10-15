import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The admin talks to the API only from the server (BFF); the API URL never reaches the browser.
  poweredByHeader: false,
  transpilePackages: ['@1pos/validation'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
