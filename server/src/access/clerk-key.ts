/** The Clerk frontend origin ("https://<host>") decoded from a publishable
 *  key. Handles both payload formats: classic base64("<host>$") and the newer
 *  base64url JSON {"iss"}. Null when the key is absent or malformed (callers
 *  fail closed / omit). The host charset check is the stricter of the two
 *  historical variants and is kept. */
export function clerkFrontendOrigin(pk = process.env.CLERK_PUBLISHABLE_KEY ?? ""): string | null {
  const m = pk.match(/^pk_(?:test|live)_(.+)$/);
  if (!m) return null;
  try {
    const norm = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4)).trim();
    let host = "";
    if (decoded.startsWith("{")) {
      const iss = String((JSON.parse(decoded) as { iss?: unknown }).iss ?? "");
      host = iss.replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
    } else {
      host = decoded.replace(/\$$/, "");
    }
    return host && /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
  } catch {
    return null;
  }
}
