import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

describe('cyclog shipment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ok: true}))
    );
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('ships send.pressed when it is beyond the ordinary burst cap', async () => {
    const logging = await import('../shared/logging');
    // shipment is LOCAL-mode behavior now (hosted is report-only); this test
    // is about the burst cap, so it runs as a local app.
    logging.setLogAutoShip(true);
    for (let i = 0; i < 60; i++) logging.cyclog('ordinary.event', {i});
    logging.cyclog('send.pressed', {chars: 14});

    expect(logging.logTail(100)).toContainEqual(
      expect.stringContaining('app log.ratecap cap=60/s')
    );
    expect(logging.logTail(100)).toContainEqual(expect.stringContaining('app send.pressed'));
    expect(logging.logShipState().dropped).toBe(0);

    await vi.runAllTimersAsync();
    const shipped = vi
      .mocked(fetch)
      .mock.calls.map((call) => String((call[1] as RequestInit).body))
      .join('\n');
    expect(shipped).toContain('app send.pressed');
  });
});
