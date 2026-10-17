import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

/**
 * Content Security Policy without nonces (Next 16 guide, "Without Nonces"): only this origin may
 * supply scripts, styles, images, fonts and fetches; nothing may frame the admin or post its forms
 * elsewhere. Inline scripts are still allowed (Next's bootstrap); a nonce policy is a follow-up
 * (ADR-0016 slice 1). React needs eval only in development.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  // The admin talks to the API only from the server (BFF); the API URL never reaches the browser.
  poweredByHeader: false,
  transpilePackages: ['@1pos/validation'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
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
