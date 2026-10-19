import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

/**
 * The Content Security Policy is set per request in `src/proxy.ts` (a fresh script nonce each time,
 * session 16). Files the proxy does not see (`/_next/static`) carry this fallback, which allows no
 * script at all: they are scripts and styles themselves, never pages.
 */
const staticCsp = "default-src 'none'; frame-ancestors 'none'";

const nextConfig: NextConfig = {
  // The admin talks to the API only from the server (BFF); the API URL never reaches the browser.
  poweredByHeader: false,
  transpilePackages: ['@1pos/validation'],
  async headers() {
    return [
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Content-Security-Policy', value: staticCsp }],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Also keeps the password-reset token in the URL from leaking to other sites.
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Browsers ignore HSTS over plain http and for IP hosts, so local `next start` is unaffected.
          ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
        ],
      },
    ];
  },
};

export default nextConfig;
