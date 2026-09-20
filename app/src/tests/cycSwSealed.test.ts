import {describe, expect, test, beforeAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {importEngineKey, deriveEngineNotifyKey, sealPush, randomBytes} from '@shared/e2e';

type SwGlobals = {
  cycSealedContent: (
    item: unknown,
    decrypted: unknown
  ) => {title: string; body: string; count: number; open: string};
  cycDeriveEngineNotifyKey: (k: CryptoKey) => Promise<CryptoKey>;
  cycDeriveSessionKey: (k: CryptoKey, sessionId: string) => Promise<CryptoKey>;
  cycOpenPush: (k: CryptoKey, blob: string) => Promise<any>;
  resolveSealed: (
    item: unknown
  ) => Promise<{title: string; body: string; count: number; open: string}>;
};
let sw: SwGlobals;
beforeAll(() => {
  const code = readFileSync(resolve(process.cwd(), 'public/cyc-sw.js'), 'utf8');
  const fakeSelf: Record<string, unknown> = {
    addEventListener: () => {},
    navigator: {userAgent: 'vitest'},
    registration: {
      showNotification: () => {},
      getNotifications: async (): Promise<unknown[]> => []
    },
    clients: {claim: async () => {}, matchAll: async (): Promise<unknown[]> => []},
    skipWaiting: () => {}
  };

  new Function('self', code)(fakeSelf);
  sw = fakeSelf as unknown as SwGlobals;
});
describe('service worker sealed engine-level push', () => {
  test('cycSealedContent surfaces the sealed `open` target, and defaults it empty', () => {
    const withOpen = sw.cycSealedContent(
      {title: 'CallYourCode', body: 'New message', kid: 'k', enc: 'e'},
      {
        title: '93% of the 5-hour limit',
        body: 'sam@example.com · resets soon',
        open: 'usage:enginebox'
      }
    );
    expect(withOpen.title).toBe('93% of the 5-hour limit');
    expect(withOpen.body).toBe('sam@example.com · resets soon');
    expect(withOpen.open).toBe('usage:enginebox');

    const fallback = sw.cycSealedContent({title: 'CallYourCode', body: 'New message'}, null);
    expect(fallback).toEqual({title: 'CallYourCode', body: 'New message', count: 1, open: ''});
  });
  test('an engine-scope item decrypts under the notify key and surfaces open; a session key cannot', async () => {
    const kEngine = await importEngineKey(randomBytes(32));
    const kNotify = await deriveEngineNotifyKey(kEngine);
    const pt = {
      title: '93% of the 5-hour limit',
      body: 'sam@example.com · resets soon',
      open: 'usage:enginebox'
    };
    const enc = await sealPush(kNotify, pt);

    const opened = await sw.cycOpenPush(await sw.cycDeriveEngineNotifyKey(kEngine), enc);
    expect(opened).toEqual(pt);

    const content = sw.cycSealedContent(
      {kid: 'k', enc, title: 'CallYourCode', body: 'New message'},
      opened
    );
    expect(content.open).toBe('usage:enginebox');

    await expect(sw.cycOpenPush(await sw.cycDeriveSessionKey(kEngine, ''), enc)).rejects.toThrow();
  });
  test('resolveSealed never throws and never drops: an item with no known key falls back generic', async () => {
    const out = await sw.resolveSealed({
      kid: 'unknown-kid',
      enc: 'not-a-real-blob',
      title: 'CallYourCode',
      body: 'New message'
    });
    expect(out).toEqual({title: 'CallYourCode', body: 'New message', count: 1, open: ''});

    const bare = await sw.resolveSealed({
      title: 'CallYourCode',
      body: 'New message',
      sessionId: ''
    });
    expect(bare.title).toBe('CallYourCode');
    expect(bare.open).toBe('');
  });
});
