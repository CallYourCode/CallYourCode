import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

/* THE HOSTED PRIVACY GATE (shared/logging.ts). Local ships the diagnostic log
 * automatically; hosted (clerk auth) is report-only, so the auto-shipper must
 * stay silent there, and silent BEFORE the mode is known at all (fail-private).
 * Module state is real state: every test imports a fresh copy. */

const posts: Array<{url: string; body: unknown}> = [];

async function freshLogging() {
  vi.resetModules();
  return await import('../shared/logging');
}

beforeEach(() => {
  posts.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: {body?: unknown}) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null
      });
      return {ok: true} as Response;
    })
  );
  try {
    localStorage.clear();
  } catch {}
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the log auto-ship gate', () => {
  test('nothing ships before the mode is known (fail-private default)', async () => {
    const log = await freshLogging();
    log.cyclog('boot.one', {n: 1});
    log.cyclog('boot.two', {n: 2});
    await vi.advanceTimersByTimeAsync(6000);
    expect(posts.filter((p) => p.url.includes('/clientlog'))).toHaveLength(0);
    // the lines are held, not lost: the ring has them for a bug report
    expect(log.logTail(10).join('\n')).toContain('boot.one');
  });

  test('a local config enables shipping and the earlier lines go too', async () => {
    const log = await freshLogging();
    log.cyclog('early.line', {});
    log.setLogAutoShip(true); // contract.ts: config known, auth not clerk
    log.cyclog('later.line', {});
    await vi.advanceTimersByTimeAsync(2000);
    const sent = posts.filter((p) => p.url.includes('/clientlog'));
    expect(sent.length).toBeGreaterThan(0);
    const lines = sent.flatMap((p) => (p.body as {lines: string[]}).lines);
    expect(lines.join('\n')).toContain('early.line');
    expect(lines.join('\n')).toContain('later.line');
  });

  test('a clerk (hosted) config keeps the shipper silent', async () => {
    const log = await freshLogging();
    log.setLogAutoShip(false); // contract.ts: cfg.auth === 'clerk'
    log.cyclog('hosted.line', {});
    await vi.advanceTimersByTimeAsync(6000);
    expect(posts.filter((p) => p.url.includes('/clientlog'))).toHaveLength(0);
  });

  test('?devlog=1 forces shipping even in hosted mode (a debugging session)', async () => {
    localStorage.setItem('cyc:devlog', '1');
    const log = await freshLogging();
    log.setLogAutoShip(false);
    log.cyclog('debug.line', {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(posts.filter((p) => p.url.includes('/clientlog')).length).toBeGreaterThan(0);
  });

  test('?devlog=0 silences even a local app', async () => {
    localStorage.setItem('cyc:devlog', '0');
    const log = await freshLogging();
    log.setLogAutoShip(true);
    log.cyclog('muted.line', {});
    await vi.advanceTimersByTimeAsync(6000);
    expect(posts.filter((p) => p.url.includes('/clientlog'))).toHaveLength(0);
  });
});
