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
