import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/** Headers the admin web's server (BFF) adds to its calls (session 40). */
export const BFF_SECRET_HEADER = 'x-onepos-bff';
export const CLIENT_IP_HEADER = 'x-onepos-client-ip';

const CLIENT_IP = Symbol('clientIp');
type WithClientIp = { [CLIENT_IP]?: string };

/**
 * The admin calls the API from its own server, so `req.ip` is that server for every visitor of every
 * business. With the shared secret (compared in constant time) the visitor's address it sends is
 * believed instead; without it the header is ignored, so nobody else can choose their own bucket.
 */
export function clientIpMiddleware(secret: string | undefined) {
  const expected = secret ? Buffer.from(secret) : null;
  return (req: Request, _res: Response, next: NextFunction): void => {
    const given = req.header(BFF_SECRET_HEADER);
    const ip = req.header(CLIENT_IP_HEADER)?.trim();
    if (expected && given && ip && isIP(ip)) {
      const g = Buffer.from(given);
      if (g.length === expected.length && timingSafeEqual(g, expected)) (req as WithClientIp)[CLIENT_IP] = ip;
    }
    next();
  };
}

/** The address per-IP limits count: the admin's visitor when the admin vouched for it, else `req.ip`. */
export const clientIp = (req: Pick<Request, 'ip'>): string | undefined => (req as WithClientIp)[CLIENT_IP] ?? req.ip;
