/* Cloud onboarding: the /enroll page, its grant mint, and the device flow.
 *
 * The Claude-Code-style device flow. The engine's pair command starts a
 * device session (POST /enroll/device: a cyd_ device code it keeps and a cyu_
 * user code), opens `<app>/enroll?code=<cyu_>` in a browser, and polls
 * POST /enroll/device/poll. The user signs in with Clerk (Google); the page
 * calls POST /enroll/grant with the session, which mints the one-time cyg_
 * grant (grants.ts) and ATTACHES it to the device session; the engine's poll
 * receives the grant and enrolls with it. No localhost callback server: the
 * poll IS the channel, so the browser can even be on another device.
 *
 * MANUAL FALLBACK: /enroll opened with no ?code= (or with a dead one) still
 * shows the grant for a copy-paste into the terminal, the original flow.
 *
 * Kept out of server.ts on purpose (its own routes, its own file) so the
 * parallel relay work in server.ts merges around it, and because this page is
 * the first thing a new user sees: it should be readable in one screen.
 *
 * CSP fit: server.ts serves documents with script-src 'self' blob: plus the
 * Clerk host and NO 'unsafe-inline', so the page carries no inline script; its
 * logic is GET /enroll.js (same-origin), which injects Clerk's browser bundle
 * from the Clerk host both lists. Inline STYLE is allowed and used.
 *
 * LOCAL mode has no auth and no grants: /enroll renders a "nothing to do
 * here" page and /enroll/grant does not exist (404), so this surface adds
 * nothing to a trusted-network deploy.
 */

import type { EnrollDevices, EnrollGrants } from "../access/grants";
import { grantRate, type RateBucket } from "../platform/ratelimit";
import { ENROLL_DEVICE_RATE_MAX, ENROLL_POLL_RATE_MAX } from "../platform/caps";

import { clerkFrontendOrigin } from "../access/clerk-key";

/** The page. One sign-in, then the code with a copy button and one line of
 *  instruction. Styling is deliberately spare: system font, one accent. */
export function enrollPageHtml(hosted: boolean): string {
  const body = hosted
    ? `<div id="signin"></div>
  <p id="status">Loading sign-in&hellip;</p>
  <div id="linked" hidden>
    <p class="lead">You're signed in. This machine is now linked.</p>
    <p class="hint">Return to your terminal to finish pairing.</p>
  </div>
  <div id="done" hidden>
    <p class="lead">You're signed in. Link your machine:</p>
    <div class="coderow"><code id="code"></code><button id="copy" type="button">Copy</button></div>
    <p class="hint">Paste this code into your terminal. It works once and expires in a few minutes.</p>
  </div>
  <script src="/enroll.js"></script>`
    : `<p class="lead">This server runs in local mode.</p>
  <p class="hint">There is no sign-in and no code here: engines on this network enroll directly.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link your machine - CallYourCode</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100dvh; }
  main { max-width: 26rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1.25rem; }
  .lead { margin: 0 0 1rem; }
  .hint { font-size: .85rem; opacity: .7; margin-top: 1rem; }
  #status { font-size: .9rem; opacity: .7; }
  .coderow { display: flex; gap: .5rem; justify-content: center; align-items: stretch; }
  code { font-size: 1.05rem; padding: .55rem .8rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
         border-radius: .5rem; user-select: all; letter-spacing: .02em; }
  button { font: inherit; padding: .55rem .9rem; border-radius: .5rem; cursor: pointer;
           border: 1px solid transparent; background: #4f46e5; color: #fff; }
  button:active { opacity: .85; }
  #signin { display: flex; justify-content: center; }
</style>
</head>
<body>
<main>
  <h1>CallYourCode</h1>
  ${body}
</main>
</body>
</html>
`;
}

/** The page's logic, served same-origin so the locked CSP allows it. The
 *  Clerk bundle is injected from the Clerk frontend host (also in the CSP);
 *  once a user exists the script trades the session for a grant and shows it.
 *  The Clerk session JWT lives and dies inside this fetch: it is never
 *  displayed and never leaves the browser except to THIS origin. */
export function enrollPageJs(publishableKey: string, clerkOrigin: string | null): string {
  return `"use strict";
(async () => {
  const pk = ${JSON.stringify(publishableKey)};
  const src = ${JSON.stringify(clerkOrigin ? `${clerkOrigin}/npm/@clerk/clerk-js@5/dist/clerk.browser.js` : null)};
  const $ = (id) => document.getElementById(id);
  const status = (t) => { $("status").hidden = !t; $("status").textContent = t || ""; };
  /* The device flow's user code, when the engine opened this page. Read once,
   * then scrubbed from the address bar so it cannot ride a Referer or land in
   * history sync. */
  const userCode = new URLSearchParams(location.search).get("code") || "";
  if (userCode) history.replaceState(null, "", "/enroll");
  if (!pk || !src) { status("Sign-in is not configured on this server."); return; }

  const tag = document.createElement("script");
  tag.src = src;
  tag.async = true;
  tag.crossOrigin = "anonymous";
  tag.setAttribute("data-clerk-publishable-key", pk);
  const loaded = new Promise((res, rej) => { tag.onload = res; tag.onerror = rej; });
  document.head.appendChild(tag);
  try {
    await loaded;
    await window.Clerk.load();
  } catch {
    status("Could not load sign-in. Check your connection and reload.");
    return;
  }

  let revealed = false;
  const reveal = async () => {
    if (revealed) return;
    revealed = true;
    status("Issuing your code\\u2026");
    try {
      const jwt = await window.Clerk.session.getToken();
      const res = await fetch("/enroll/grant", {
        method: "POST",
        headers: { authorization: "Bearer " + jwt, "content-type": "application/json" },
        body: JSON.stringify({ code: userCode }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j) throw new Error("refused");
      if (j.attached === true) {
        /* The grant rode the device session to the engine: nothing to copy. */
        $("signin").hidden = true;
        status("");
        $("linked").hidden = false;
        return;
      }
      if (typeof j.grant !== "string") throw new Error("refused");
      $("signin").hidden = true;
      status("");
      $("code").textContent = j.grant;
      $("done").hidden = false;
      $("copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(j.grant); $("copy").textContent = "Copied"; }
        catch { /* selection stays; user copies by hand */ }
      });
    } catch {
      revealed = false;
      status("Could not issue a code. Reload to try again.");
    }
  };

  if (window.Clerk.user) {
    await reveal();
  } else {
    status("");
    window.Clerk.mountSignIn($("signin"));
    window.Clerk.addListener((s) => { if (s.user && s.session) void reveal(); });
  }
})();
`;
}

export type OnboardDeps = {
  hosted: boolean;
  grants: EnrollGrants;
  devices: EnrollDevices;
  /** server.ts's Clerk-session resolver: the verified sub, or null. */
  sessionSub: (req: Request) => Promise<string | null>;
  docHeaders: Record<string, string>;
  baseHeaders: Record<string, string>;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The caller's rate-bucket identity for the two UNAUTHENTICATED device
   *  routes; server.ts passes ratelimit.ts's clientKeyOf (the same source key
   *  push/clientlog use). Absent (page-rendering tests), every caller shares
   *  one bucket. */
  rateKey?: (req: Request) => string;
};

/* FLOOD PROTECTION for the two routes anyone may call without a credential
 * (grantRate, the push/clientlog pattern): /enroll/device could otherwise
 * churn the DEVICE_SESSIONS_MAX store, and the poll invites hammering.
 * Module-level (onboardRoutes is a plain function, not a factory): one server
 * process is one bucket set, which is what a per-source cap wants. */
const deviceRate = new Map<string, RateBucket>();
const pollRate = new Map<string, RateBucket>();

const tooMany = () =>
  new Response(JSON.stringify({ error: "too many requests" }), {
    status: 429, headers: { "content-type": "application/json" },
  });

/** The onboarding routes, or null when `path` is none of them. server.ts
 *  calls this from its fetch with its own headers and session resolver so this
 *  file owns the flow without owning any policy. */
export async function onboardRoutes(req: Request, path: string, deps: OnboardDeps): Promise<Response | null> {
  if (path === "/enroll" && req.method === "GET") {
    return new Response(enrollPageHtml(deps.hosted), {
      headers: {
        ...deps.docHeaders,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  if (path === "/enroll.js" && req.method === "GET") {
    return new Response(enrollPageJs(process.env.CLERK_PUBLISHABLE_KEY ?? "", clerkFrontendOrigin()), {
      headers: {
        ...deps.baseHeaders,
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  /* THE MINT. The one and only place a grant is born, and it requires a live
   * Clerk session: the sub the verifier answers is the owner the grant is
   * bound to, never anything off a body. LOCAL has no grants at all.
   *
   * When the body carries a device-flow user code that attaches, the grant
   * rides the session to the polling engine and the page never sees it; a
   * missing or dead code degrades to showing the grant for the manual copy. */
  if (path === "/enroll/grant" && req.method === "POST") {
    if (!deps.hosted) return new Response("not found", { status: 404 });
    const sub = await deps.sessionSub(req);
    if (!sub) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const body = (await req.json().catch(() => null)) as any;
    const userCode = typeof body?.code === "string" ? body.code : "";
    const g = deps.grants.mint(sub);
    deps.log?.("enroll.grant.minted", { sub, expiresAt: g.expiresAt });
    if (userCode && deps.devices.attach(userCode, g.code)) {
      deps.log?.("enroll.grant.attached", { sub, expiresAt: g.expiresAt });
      return new Response(JSON.stringify({ attached: true, expiresAt: g.expiresAt }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return new Response(JSON.stringify({ grant: g.code, expiresAt: g.expiresAt }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  /* DEVICE SESSION START (the engine, before it has any credential). Both
   * codes go back in the answer; the engine keeps cyd_ and sends cyu_ to the
   * browser in the /enroll?code= url it opens. LOCAL has no device flow. */
  if (path === "/enroll/device" && req.method === "POST") {
    if (!deps.hosted) return new Response("not found", { status: 404 });
    /* Unauthenticated, so rate-capped per source: a real pairing is ONE
     * create; a loop churning the session store is refused here. */
    if (grantRate(deviceRate, deps.rateKey?.(req) ?? "?", 1, ENROLL_DEVICE_RATE_MAX,
        "enroll.device.rate.limited", deps.log ?? (() => {})) < 1) {
      return tooMany();
    }
    const d = deps.devices.start();
    deps.log?.("enroll.device.started", { expiresAt: d.expiresAt });
    return new Response(
      JSON.stringify({ device: d.deviceCode, code: d.userCode, expiresAt: d.expiresAt, intervalMs: 2000 }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }

  /* THE POLL. Pending until the page attaches the grant; the grant is handed
   * out exactly once (the session dies with the answer); anything unknown or
   * expired is 404 so the engine stops polling. */
  if (path === "/enroll/device/poll" && req.method === "POST") {
    if (!deps.hosted) return new Response("not found", { status: 404 });
    /* Unauthenticated too. A real engine polls every 2s (30 a minute), which
     * sits at half this cap; a hammer is held to one poll a second. */
    if (grantRate(pollRate, deps.rateKey?.(req) ?? "?", 1, ENROLL_POLL_RATE_MAX,
        "enroll.device.poll.rate.limited", deps.log ?? (() => {})) < 1) {
      return tooMany();
    }
    const body = (await req.json().catch(() => null)) as any;
    const r = deps.devices.poll(typeof body?.device === "string" ? body.device : "");
    if (r.status === "unknown") {
      return new Response(JSON.stringify({ error: "unknown" }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }
    if (r.status === "granted") deps.log?.("enroll.device.granted", {});
    return new Response(JSON.stringify(r), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  return null;
}
