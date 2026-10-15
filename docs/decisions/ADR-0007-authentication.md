# ADR-0007: Authentication and sessions

- Status: Accepted (2026-10-15)

## Decision
- Passwords: argon2id (memory-hard parameters reviewed at Phase 1).
- Access token: JWT, 15 min TTL, claims = `sub`, `sid` (session id), `tid` (active tenant), `mid` (membership). Permissions are **not** embedded — they are loaded server-side per request (cached briefly) so revocation is immediate.
- Refresh token: opaque random, stored hashed in `user_sessions`, rotated on every use; reuse of a rotated token revokes the whole session family.
- MFA: TOTP required for tenant owners/admins, accountants, and platform staff.
- Cashier fast login: PIN on a registered terminal, valid only on that terminal and only while the terminal credential is active; PIN never usable over the public API alone.
- Terminal credential: per-device key pair or long random secret issued at registration, revocable; revoked terminals cannot sync (replay prevention).

## Why not an external IdP now
Avoids a vendor dependency for the pilot and keeps terminal/PIN flows under our control. OIDC SSO for enterprise tenants can be added as an additional login method later.
