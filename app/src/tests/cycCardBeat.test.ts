import {describe, expect, test} from 'vitest';
import {beatKey, logSkip, readBeat, sameBeat, SKIP_LOG_EVERY} from '../components/cardBeat';

describe('readBeat', () => {
  test('rejects anything that is not a card heartbeat', () => {
    expect(readBeat(null)).toBeNull();
    expect(readBeat(undefined)).toBeNull();
    expect(readBeat('x')).toBeNull();
    expect(readBeat({})).toBeNull();
    expect(readBeat({cycCardRender: 2, nonEmpty: true})).toBeNull();
    expect(readBeat({cycCardRender: 1})).toBeNull();
    expect(readBeat({cycCardRender: 1, nonEmpty: 'true'})).toBeNull();
    // A sandbox shim message with a different marker is not a heartbeat.
    expect(readBeat({cyc: 1, type: 'cyc:save'})).toBeNull();
  });

  test('normalises height (ceil, >=0) and nodes (int, >=0)', () => {
    expect(readBeat({cycCardRender: 1, nonEmpty: true, height: 75.2, nodes: 6})).toEqual({
      nonEmpty: true,
      height: 76,
      nodes: 6
    });
    expect(readBeat({cycCardRender: 1, nonEmpty: true, height: -3, nodes: 6.9})).toEqual({
      nonEmpty: true,
      height: 0,
      nodes: 6
    });
    expect(readBeat({cycCardRender: 1, nonEmpty: false})).toEqual({
      nonEmpty: false,
      height: 0,
      nodes: 0
    });
    expect(readBeat({cycCardRender: 1, nonEmpty: true, height: NaN, nodes: Infinity})).toEqual({
      nonEmpty: true,
      height: 0,
      nodes: 0
    });
    expect(readBeat({cycCardRender: 1, nonEmpty: true, height: '76', nodes: '6'})).toEqual({
      nonEmpty: true,
      height: 0,
      nodes: 0
    });
  });
});

describe('beatKey / sameBeat', () => {
  const a = {nonEmpty: true, height: 76, nodes: 6};

  test('two reports of the same paint compare equal', () => {
    expect(beatKey(a)).toBe('1|76|6');
    expect(sameBeat(beatKey(a), {...a})).toBe(true);
    // Sub-pixel jitter is normalised away before the compare.
    expect(sameBeat(beatKey(a), readBeat({cycCardRender: 1, nonEmpty: true, height: 75.4, nodes: 6})!)).toBe(
      true
    );
  });

  test('a changed height or node count is a new render', () => {
    expect(sameBeat(beatKey(a), {...a, height: 77})).toBe(false);
    expect(sameBeat(beatKey(a), {...a, nodes: 7})).toBe(false);
  });

  test('the first beat of a frame is never a skip', () => {
    expect(sameBeat(null, a)).toBe(false);
  });

  test('an empty report is never a skip, even twice in a row', () => {
    const empty = {nonEmpty: false, height: 0, nodes: 0};
    expect(sameBeat(beatKey(empty), empty)).toBe(false);
    expect(sameBeat(beatKey(a), empty)).toBe(false);
  });
});

describe('logSkip', () => {
  test('logs the first skip on a frame and then every 64th', () => {
    expect(SKIP_LOG_EVERY).toBe(64);
    const logged = [];
    for (let n = 1; n <= 200; n++) if (logSkip(n)) logged.push(n);
    expect(logged).toEqual([1, 64, 128, 192]);
  });
});
