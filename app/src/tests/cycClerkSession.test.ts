/* Hermetic clerkSession behaviour for the HOSTED sign-in redirect. window.Clerk
 * is a fake exposing the v5 surface the app uses (session/getToken,
 * redirectToSignIn, signOut); window.location/history are stubbed so nothing
 * navigates the test runner. Modules are re-imported per test so the loader's
 * cached promise and the boot-check latch start fresh.
 *
 * The claims under test:
 *  - logged out (getToken null) -> ensureSessionOrGate redirects to hosted sign-in.
 *  - signed in (getToken returns a token) -> no redirect.
 *  - returning on a __clerk_handshake URL with a token -> no redirect, URL cleaned.
 *  - clerkSignOut -> Clerk.signOut is called.
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// pk_live_ base64("clerk.callyourcode.com$") - the real allowed key shape.
const KEY = 'pk_live_Y2xlcmsuY2FsbHlvdXJjb2RlLmNvbSQ';

type FakeClerk = {
  loaded: boolean;
  user: unknown;
  session: {getToken: () => Promise<string | null>} | null;
  redirectToSignIn: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
};

const makeClerk = (token: string | null): FakeClerk => ({
  loaded: true,
  user: token ? {} : null,
  session: {getToken: async () => token},
  redirectToSignIn: vi.fn(),
  signOut: vi.fn(async () => undefined),
  load: vi.fn(async () => undefined)
});

const stubLocation = (href: string) => {
  const url = new URL(href);
  vi.stubGlobal('location', {
    href: url.href,
    origin: url.origin,
    search: url.search,
    hash: url.hash,
    replace: vi.fn()
  } as unknown as Location);
};

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  delete (window as {Clerk?: unknown}).Clerk;
  delete (window as {__cycClerkToken?: unknown}).__cycClerkToken;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clerkSession hosted redirect', () => {
  test('logged out: ensureSessionOrGate redirects to hosted sign-in', async () => {
    stubLocation('https://app.callyourcode.com/');
    const clerk = makeClerk(null);
    (window as {Clerk?: unknown}).Clerk = clerk;
    const {configureClerkKey, ensureSessionOrGate} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    await ensureSessionOrGate();
    await settle();
    expect(clerk.redirectToSignIn).toHaveBeenCalledTimes(1);
    expect(clerk.redirectToSignIn.mock.calls[0][0]).toMatchObject({
      signInForceRedirectUrl: 'https://app.callyourcode.com/',
      signUpForceRedirectUrl: 'https://app.callyourcode.com/'
    });
  });

  test('signed in: ensureSessionOrGate does not redirect', async () => {
    stubLocation('https://app.callyourcode.com/');
    const clerk = makeClerk('a.jwt.token');
    (window as {Clerk?: unknown}).Clerk = clerk;
    const {configureClerkKey, ensureSessionOrGate} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    await ensureSessionOrGate();
    await settle();
    expect(clerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  test('returning on a __clerk_handshake URL with a token: no redirect, URL cleaned', async () => {
    stubLocation('https://app.callyourcode.com/?__clerk_handshake=abc');
    const clerk = makeClerk('a.jwt.token');
    (window as {Clerk?: unknown}).Clerk = clerk;
    const replaceState = vi.fn();
    vi.stubGlobal('history', {state: null, replaceState} as unknown as History);
    const {configureClerkKey, ensureSessionOrGate} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    await ensureSessionOrGate();
    await settle();
    expect(clerk.redirectToSignIn).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  test('clerkSignOut calls Clerk.signOut then boots to /', async () => {
    stubLocation('https://app.callyourcode.com/');
    const clerk = makeClerk('a.jwt.token');
    (window as {Clerk?: unknown}).Clerk = clerk;
    const {configureClerkKey, clerkSignOut} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    await clerkSignOut();
    await settle();
    expect(clerk.signOut).toHaveBeenCalledTimes(1);
    expect((location as unknown as {replace: ReturnType<typeof vi.fn>}).replace).toHaveBeenCalledWith(
      '/'
    );
  });

  test('isSignedIn reflects the session token', async () => {
    stubLocation('https://app.callyourcode.com/');
    (window as {Clerk?: unknown}).Clerk = makeClerk('a.jwt.token');
    const {configureClerkKey, isSignedIn} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    expect(await isSignedIn()).toBe(true);
  });
});
