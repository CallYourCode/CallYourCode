export const HOSTED = !!process.env.CLERK_SECRET_KEY;

/** The bearer token or Clerk's `__session` cookie, whichever a request carries.
 *  Null if it carries neither. */
export function tokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const cookie = req.headers.get("cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === "__session") {
        return decodeURIComponent(part.slice(eq + 1).trim()) || null;
      }
    }
  }
  return null;
}

/** The one line the boot log prints so which mode is running is never a guess. */
export function modeLine(): string {
  if (!HOSTED) return "auth      LOCAL (no CLERK_SECRET_KEY: no login, single owner)";
  const src = process.env.CLERK_JWKS_URL
    ? "CLERK_JWKS_URL"
    : process.env.CLERK_PUBLISHABLE_KEY
      ? "CLERK_PUBLISHABLE_KEY"
      : "(no JWKS source: every token will fail closed)";
  return `auth      HOSTED (Clerk sessions required; keys from ${src})`;
}
