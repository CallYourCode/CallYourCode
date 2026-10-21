import {afterEach, expect, it, vi} from 'vitest';
const clerk = vi.hoisted(() => ({configureClerkKey: vi.fn(), ensureSessionOrGate: vi.fn(),
  getSessionToken: vi.fn(async () => 'scratch-token'), hideSignIn: vi.fn(), showSignIn: vi.fn()}));
vi.mock('../engine/clerkSession', () => clerk);
import {appFetch, isClerkAuth, setAppAuth} from '../engine/appFetch';
afterEach(() => {setAppAuth('none', null); vi.unstubAllGlobals(); vi.clearAllMocks();});
it('shipped default is ordinary fetch without login or a bearer', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok')); vi.stubGlobal('fetch', fetcher);
  expect(isClerkAuth()).toBe(false);
  await appFetch('/config');
  expect(fetcher).toHaveBeenCalledWith('/config', undefined);
  expect(clerk.getSessionToken).not.toHaveBeenCalled();
  expect(clerk.ensureSessionOrGate).not.toHaveBeenCalled();
});
it('explicit dormant Clerk setup remains directly testable', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok')); vi.stubGlobal('fetch', fetcher);
  setAppAuth('clerk', 'pk_test_scratch');
  await appFetch('/settings');
  expect(isClerkAuth()).toBe(true);
  expect(clerk.configureClerkKey).toHaveBeenCalledWith('pk_test_scratch');
  const options = fetcher.mock.calls[0][1] as RequestInit;
  expect(new Headers(options.headers).get('authorization')).toBe('Bearer scratch-token');
});
