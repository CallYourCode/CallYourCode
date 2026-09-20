import {
  configureClerkKey,
  ensureSessionOrGate,
  getSessionToken,
  hideSignIn,
  showSignIn
} from './clerkSession';

type AuthMode = 'none' | 'clerk';

let authMode: AuthMode = 'none';

export function setAppAuth(auth: string | null | undefined, key: string | null | undefined): void {
  if (auth === 'clerk') {
    configureClerkKey(key ?? null);
    authMode = 'clerk';
    void ensureSessionOrGate();
  } else {
    authMode = 'none';
    configureClerkKey(null);
    hideSignIn();
  }
}

export async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  if (authMode !== 'clerk') return fetch(input, init);
  const headers = new Headers(init?.headers);
  const token = await getSessionToken();
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, {...init, headers});
  if (res.status === 401) void showSignIn();
  return res;
}
