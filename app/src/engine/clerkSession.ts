type ClerkSession = {getToken(): Promise<string | null>};
type ClerkJS = {
  load(opts?: Record<string, unknown>): Promise<unknown>;
  loaded?: boolean;
  user?: unknown;
  session?: ClerkSession | null;
  redirectToSignIn?(opts?: Record<string, unknown>): Promise<unknown> | void;
  handleRedirectCallback?(opts?: Record<string, unknown>): Promise<unknown>;
  signOut?(opts?: Record<string, unknown>): Promise<unknown>;
};

declare global {
  interface Window {
    Clerk?: ClerkJS;
    __cycClerkToken?: () => string | null | Promise<string | null>;
  }
}

let publishableKey: string | null = null;
let clerkPromise: Promise<ClerkJS | null> | null = null;
let bootCheckStarted = false;

function fakeToken(): (() => string | null | Promise<string | null>) | null {
  return typeof window.__cycClerkToken === 'function' ? window.__cycClerkToken : null;
}

const CLERK_PROD_HOSTS = new Set(['clerk.callyourcode.com']);
const CLERK_DEV_HOST_RE = /^[a-z0-9-]+\.clerk\.accounts\.dev$/;
const CLERK_JS_VERSION = '5';

function allowedClerkApi(iss: string): string | null {
  try {
    const u = new URL(/^https?:\/\//.test(iss) ? iss : 'https://' + iss);
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (CLERK_PROD_HOSTS.has(host) || CLERK_DEV_HOST_RE.test(host)) return 'https://' + host;
    return null;
  } catch {
    return null;
  }
}

export function frontendApiFromKey(key: string): string | null {
  try {
    const raw = key.replace(/^pk_(test|live)_/, '');
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    // A Clerk publishable key is base64 of "<frontend-api-host>$" (a bare host,
    // not JSON): decode it and drop the trailing "$" to get the Frontend API host.
    const host = atob(padded).replace(/\$+$/, '').trim();
    return host ? allowedClerkApi(host) : null;
  } catch {
    return null;
  }
}

// True when this page load is the return leg of a Clerk redirect (OAuth SSO)
// and the handshake still needs finishing. clerk-js parks the browser at
// `/?b=...#/sso-callback` (hash form) or drops one of its handshake params into
// the query; either means: call handleRedirectCallback, then boot to `/`.
function isClerkCallbackUrl(): boolean {
  try {
    if (/sso-callback/.test(location.hash)) return true;
    const q = new URLSearchParams(location.search);
    return (
      q.has('__clerk_handshake') ||
      q.has('__clerk_status') ||
      q.has('__clerk_ticket') ||
      q.has('__clerk_db_jwt')
    );
  } catch {
    return false;
  }
}

function loadScript(src: string, pubKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    // clerk-js v5's browser build auto-initializes window.Clerk from this
    // attribute; without it the script throws "Missing publishableKey" and never
    // sets window.Clerk, so the sign-in never mounts.
    s.setAttribute('data-clerk-publishable-key', pubKey);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('clerk script failed to load'));
    document.head.appendChild(s);
  });
}

async function loadClerk(): Promise<ClerkJS | null> {
  if (clerkPromise) return clerkPromise;
  clerkPromise = (async () => {
    if (fakeToken()) return null;
    if (!publishableKey) return null;
    const api = frontendApiFromKey(publishableKey);
    if (!api) return null;
    // Only inject the script when no instance exists yet: if window.Clerk is
    // already present the constructor has run, and a second injection just races
    // the running auto-load.
    if (!window.Clerk) {
      try {
        await loadScript(`${api}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`, publishableKey);
      } catch {
        // The script tag may still have constructed window.Clerk via the
        // data-attribute auto-load before the onerror fired; fall through and let
        // the wait below decide, rather than dropping the gate outright.
      }
      // Wait for the constructor to appear.
      for (let i = 0; i < 100 && !window.Clerk; i++) await new Promise((r) => setTimeout(r, 50));
    }
    if (!window.Clerk) return null;
    // `loaded` can lag well behind construction. If it has not flipped, kick a
    // load() ourselves inside its OWN try/catch: the data-attribute auto-load may
    // already be running, so a throw here is expected and tolerated. Then poll
    // for `loaded` up to ~5s and RETURN the instance regardless: getToken and
    // redirectToSignIn guard themselves, so a still-false flag is tolerated.
    if (!window.Clerk.loaded) {
      try {
        await window.Clerk.load();
      } catch {}
    }
    for (let i = 0; i < 100 && !window.Clerk.loaded; i++)
      await new Promise((r) => setTimeout(r, 50));
    return window.Clerk;
  })();
  return clerkPromise;
}

export function configureClerkKey(key: string | null): void {
  publishableKey = typeof key === 'string' && key ? key : null;
}

export async function getSessionToken(): Promise<string | null> {
  const fake = fakeToken();
  if (fake) {
    try {
      const t = await fake();
      return typeof t === 'string' && t ? t : null;
    } catch {
      return null;
    }
  }
  const clerk = await loadClerk();
  if (!clerk) return null;
  try {
    return (await clerk.session?.getToken()) ?? null;
  } catch {
    return null;
  }
}

export async function isSignedIn(): Promise<boolean> {
  return !!(await getSessionToken());
}

// The embedded gate is gone (hosted redirect owns the flow); kept as a no-op so
// callers that used to tear down the gate stay valid.
export function hideSignIn(): void {}

export async function clerkSignOut(): Promise<void> {
  const clerk = await loadClerk();
  try {
    await clerk?.signOut?.({});
  } catch {}
  location.replace('/');
}

// Redirect to Clerk's HOSTED sign-in. Clerk owns the whole flow on
// accounts.callyourcode.com and returns to the app already signed in, so the
// app never renders a Clerk form itself.
export async function showSignIn(): Promise<void> {
  const clerk = await loadClerk();
  if (!clerk?.redirectToSignIn) return;
  if (await getSessionToken()) return; // already signed in, do not bounce
  // redirectToSignIn needs Clerk fully loaded to know the sign-in URL; called too
  // early it silently no-ops and the page just sits there. Wait for `loaded`
  // (up to ~10s) before redirecting.
  for (let i = 0; i < 200 && !clerk.loaded; i++) await new Promise((r) => setTimeout(r, 50));
  if (await getSessionToken()) return; // a session may have landed while we waited
  try {
    clerk.redirectToSignIn({
      signInForceRedirectUrl: location.origin + '/',
      signUpForceRedirectUrl: location.origin + '/'
    });
  } catch {}
}

export async function ensureSessionOrGate(): Promise<void> {
  if (bootCheckStarted) return;
  bootCheckStarted = true;
  const clerk = await loadClerk();
  if (!clerk) return; // clerk-js failed to load; do nothing
  let token = await getSessionToken();
  // Returning from the hosted portal carries a handshake; give the session a
  // moment to settle before deciding we are logged out.
  if (!token && isClerkCallbackUrl()) {
    for (let i = 0; i < 60 && !token; i++) {
      await new Promise((r) => setTimeout(r, 150));
      token = await getSessionToken();
    }
  }
  if (token) {
    // Signed in. Clean any handshake params off the URL without a reload.
    if (isClerkCallbackUrl()) {
      try {
        history.replaceState(history.state, '', '/');
      } catch {}
    }
    return;
  }
  if (publishableKey) await showSignIn(); // -> redirects to hosted sign-in
}
