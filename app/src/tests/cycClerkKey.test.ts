/* The Clerk publishable key is base64 of "<frontend-api-host>$" (a bare host,
 * not JSON). frontendApiFromKey must decode that host and accept it only when it
 * is an allowed Clerk host. Regression guard: an earlier version JSON.parsed the
 * key, which throws on the real format, so Clerk never loaded in HOSTED. */

import {describe, test, expect} from 'vitest';
import {frontendApiFromKey} from '../engine/clerkSession';

const mkKey = (host: string) => 'pk_live_' + btoa(host + '$');

describe('frontendApiFromKey', () => {
  test('the real callyourcode key resolves to its Clerk host', () => {
    // pk_live_ base64("clerk.callyourcode.com$")
    expect(frontendApiFromKey('pk_live_Y2xlcmsuY2FsbHlvdXJjb2RlLmNvbSQ')).toBe(
      'https://clerk.callyourcode.com'
    );
  });

  test('a Clerk dev-instance host is allowed', () => {
    expect(frontendApiFromKey(mkKey('quiet-owl-12.clerk.accounts.dev'))).toBe(
      'https://quiet-owl-12.clerk.accounts.dev'
    );
  });

  test('a host outside the allowlist is rejected', () => {
    expect(frontendApiFromKey(mkKey('clerk.benzeneai.com'))).toBeNull();
    expect(frontendApiFromKey(mkKey('evil.example.com'))).toBeNull();
  });

  test('a malformed key is rejected, never thrown', () => {
    expect(frontendApiFromKey('not-a-key')).toBeNull();
    expect(frontendApiFromKey('pk_live_')).toBeNull();
  });
});
