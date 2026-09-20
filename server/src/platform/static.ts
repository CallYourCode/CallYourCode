/* ------------------------------------------------- security headers (H3)
 * and the static file answers they ride on.
 *
 * The app origin serves the page a phone trusts with the E2E keys, so the
 * documents carry a CSP and every static answer carries the baseline headers.
 *
 * script-src IS LOCKED: 'self', blob: (the WSOLA AudioWorklet module loads
 * from a Blob URL; worklet loads are checked against script-src), and the
 * Clerk host. No 'unsafe-inline' and no 'unsafe-eval' any more:
 *   - the show/plugin sandbox used to force 'unsafe-inline' because it was
 *     srcdoc, and a srcdoc document INHERITS the embedding page's CSP. The
 *     sandbox now loads /cyc-sandbox.html (the shell below), a real document
 *     with its OWN served policy, so the inheritance chain is cut and the
 *     agent HTML keeps running inline scripts INSIDE the shell only;
 *   - 'unsafe-eval' left when the app's WSOLA stretcher moved off
 *     new Function (audio/wsola.ts builds the worklet source from
 *     wsolaStretch.toString() now).
 *
 * connect/img/media stay scheme-wide: the page dials the user's OWN engines
 * (arbitrary tailnet/LAN hosts, ws:// and plain http on a LAN), which no
 * fixed host list can name. style-src keeps 'unsafe-inline': the app sets
 * element styles everywhere, and inline STYLE is not script execution. */

import { join, normalize } from "node:path";
import { clerkFrontendOrigin } from "../access/clerk-key";

const CLERK_HOST = clerkFrontendOrigin();

export const CSP = [
  "default-src 'self'",
  `script-src 'self' blob:${CLERK_HOST ? " " + CLERK_HOST : ""}`,
  `style-src 'self' 'unsafe-inline'${CLERK_HOST ? " " + CLERK_HOST : ""}`,
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: ws: http: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export const BASE_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(self), microphone=(self), geolocation=()",
} as const;

export const DOC_SECURITY_HEADERS = {
  ...BASE_SECURITY_HEADERS,
  "content-security-policy": CSP,
} as const;

/* THE SANDBOX SHELL's own policy (the app repo's cyc-sandbox.html; see the
 * script-src note above). It must NOT get the app CSP -- the whole point is
 * that agent HTML runs inline scripts in here and nowhere else -- and it
 * must not get x-frame-options DENY, because the app embeds it. What it gets
 * instead: the `sandbox` directive, so even a DIRECT navigation to the shell
 * is an opaque origin that can never act as this origin, and frame-ancestors
 * 'self', so only this app may embed it. */
export const SANDBOX_SHELL = "cyc-sandbox.html";
export const SANDBOX_SHELL_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
} as const;

export async function serveStatic(distDir: string, pathname: string): Promise<Response> {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const path = join(distDir, rel);
  if (!path.startsWith(distDir)) return new Response("forbidden", { status: 403 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  /* The HTML is the index of everything else, so it must never be cached.
   *
   * Vite emits content-hashed asset names and empties the output directory on
   * every build, so yesterday's bundle is GONE. A cached cyc.html therefore
   * points at files that 404, and the app simply does not boot: the reported
   * symptom was an auto-reload after a deploy leaving a conversation with no
   * messages at all, while a manual reload (which revalidates) brought them
   * straight back.
   *
   * The service worker is the same argument: a stale one keeps showing the old
   * behaviour long after a deploy.
   *
   * The hashed assets are the opposite case. Their name changes whenever their
   * content does, so they can be cached hard, and telling the browser that is
   * what makes a reload cheap rather than a full re-download. */
  const noCache = rel.endsWith(".html") || rel.endsWith("cyc-sw.js") ||
    rel.endsWith("build.txt") || rel.endsWith(".webmanifest");
  const immutable = /-[A-Za-z0-9_]{8,}\.(js|css|json|svg|png|woff2?|map)$/.test(rel);
  /* Documents get the CSP; everything gets the baseline headers. The service
   * worker script is a document-shaped trust surface too, so it rides with
   * the CSP set (harmless for a classic script, meaningful for imports).
   * The sandbox shell is the one deliberate exception: its own policy. */
  const sec = rel.endsWith(SANDBOX_SHELL)
    ? SANDBOX_SHELL_HEADERS
    : rel.endsWith(".html") || rel.endsWith("cyc-sw.js")
      ? DOC_SECURITY_HEADERS : BASE_SECURITY_HEADERS;
  return new Response(file, {
    headers: {
      ...sec,
      ...(noCache ? { "cache-control": "no-cache, no-store, must-revalidate" } :
        immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
    },
  });
}
