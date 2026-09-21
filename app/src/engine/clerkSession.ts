type ClerkSession = {getToken(): Promise<string | null>};
type ClerkJS = {
  load(opts?: Record<string, unknown>): Promise<unknown>;
  loaded?: boolean;
  session?: ClerkSession | null;
  mountSignIn?(el: HTMLElement, opts?: Record<string, unknown>): void;
  addListener?(cb: (payload: {user?: unknown; session?: unknown}) => void): () => void;
};

declare global {
  interface Window {
    Clerk?: ClerkJS;
    __cycClerkToken?: () => string | null | Promise<string | null>;
  }
}

let publishableKey: string | null = null;
let clerkPromise: Promise<ClerkJS | null> | null = null;
let gateEl: HTMLElement | null = null;
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
    try {
      await loadScript(`${api}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`, publishableKey);
      // The data-clerk-publishable-key attribute makes the script construct AND
      // auto-load window.Clerk itself. Do NOT call load() ourselves: a second
      // load() races the auto-load and throws, which would leave this cached
      // promise null and the sign-in unmounted. Just wait for `loaded`.
      for (let i = 0; i < 120 && !(window.Clerk && window.Clerk.loaded); i++)
        await new Promise((r) => setTimeout(r, 50));
      return window.Clerk && window.Clerk.loaded ? window.Clerk : null;
    } catch {
      return null;
    }
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

function buildGate(): {overlay: HTMLElement; mount: HTMLElement} {
  // Just a blurred backdrop over the app; Clerk's own card is the only chrome.
  const overlay = document.createElement('div');
  overlay.className = 'cyc-clerk-gate';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;' +
    'justify-content:center;padding:24px;box-sizing:border-box;overflow:auto;' +
    'background:rgba(10,10,12,.5);' +
    'backdrop-filter:blur(14px) saturate(120%);-webkit-backdrop-filter:blur(14px) saturate(120%);';
  const mount = document.createElement('div');
  mount.className = 'cyc-clerk-gate-mount';
  overlay.appendChild(mount);
  document.body.appendChild(overlay);
  return {overlay, mount};
}

export async function showSignIn(): Promise<void> {
  if (gateEl) return;
  const clerk = await loadClerk();
  const {overlay, mount} = buildGate();
  gateEl = overlay;
  if (clerk?.mountSignIn) {
    try {
      clerk.mountSignIn(mount);

      clerk.addListener?.((p) => {
        if (p.user || p.session) hideSignIn();
      });
    } catch {}
  }
}

export function hideSignIn(): void {
  if (gateEl) {
    gateEl.remove();
    gateEl = null;
  }
}

export async function ensureSessionOrGate(): Promise<void> {
  if (bootCheckStarted) return;
  bootCheckStarted = true;
  const token = await getSessionToken();

  if (!token && publishableKey) await showSignIn();
}
