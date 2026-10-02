import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, startScrollEngine, type ScrollEngine} from './scrollEngine';

// THE SCROLL OWNER LETS GO (SCROLL-DESIGN.md, phase 3 fix-ups). While a reader
// drives (a finger down, or their own scroll or momentum still live) the
// ScrollOwner writes nothing. Two ways that "driving" was wrong, each proven by
// the phase-3 verifier and pinned here:
//
// 1. LOST TOUCHEND. A finger's touchend goes to the node it LANDED on, even once
//    that node has left the DOM. The message window re-windows rows away under a
//    finger that scrolls far, so the finger's own row can be detached by the
//    lift, and a detached node's touchend never reaches the window, where the
//    owner listened. The hold stuck down: a pinned reader stopped following
//    replies (166 / 289 / 412 px off the end after 3 arrivals). Proven with a
//    synthetic touch on both engines and a real CDP touch in Chromium.
//
// 2. MOMENTUM THROUGH A LONG FRAME. Momentum keeps scrolling through a
//    main-thread stall; the owner judged "still the reader's scroll" off the
//    virtualizer's 150 ms scrolling flag, read before it updated for the current
//    event, so one gap over 150 ms between momentum's scroll events ended
//    driving mid-fling and the re-window wrote under the moving content (20-23
//    writes in headless WebKit, whose frames run 90-270 ms). The fling here is
//    shaped like a real one: scroll events with no input of their own, gaps of
//    90-270 ms, and ONE scrollend when it stops (a programmatic step fires its
//    own scrollend, which a real fling does not, so the rig swallows those).
//
// Every programmatic write to the scroller (the scrollTop setter, scrollTo /
// scroll / scrollBy, scrollIntoView of a row) is counted, by phase, except the
// rig's own reader moves. Runs in Chromium (default config) and in Chromium +
// WebKit with -c scroll-owner.config.ts. grep token: `owner lets go`.

const INPUT = '#cyc-thread-pane .cyc-composer-input';
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';

// Long wrapping rows, so the window holds few of them and a far scroll
// unmounts the row the finger landed on.
const LONG = [
  'ok',
  'Looking at the relay now. The third peer negotiates over the same port and the second pair never releases it, so the allocation table runs out of slots after the first reconnect and every later dial lands on a closed descriptor. Rewriting the pool so each pair takes its own allocation and returns it on close.',
  'thanks, that matches what I saw in the logs last night',
  'The metrics page renders twice on load, once empty from the cached snapshot and once filled from the live query. I will hold the paint until the live query lands unless it takes longer than a second, then paint the cache, so a warm cache is one paint and a cold cache is two, both inside the frame budget.',
  'sounds right, ship it',
  'Done. The recipe scraper also stopped parsing ingredient lists with fractions like 1/2 and 3/4 because the date guard ran before the fraction parser and read them as dates; I swapped the order and added the fraction cases to the fixture set, all green now across the whole suite including the odd 1 1/2 mixed form.',
  'perfect',
  'One more: the overnight sync left a gap between the laptop and the phone where a handful of rows arrived out of order. The cause was a stale page version racing the live tail. The fix pins the page version to the pointer the attach-ok carried.'
];

const VIEWPORTS = [
  {key: 'tablet', width: 1069, height: 800},
  {key: 'phone', width: 390, height: 844}
] as const;

// Frame gaps of a fling through a loaded main thread (headless WebKit measured
// 90-270 ms), every one of them past the old 150 ms clock but the first.
const FLING_GAPS = [90, 160, 270, 120, 200, 250, 180, 270, 150, 220, 110, 260, 190, 240, 170, 270];

const WRITE_HOOK = () => {
  const w = window as unknown as Record<string, unknown> & {
    __writes: {phase: unknown; v: number}[];
  };
  w.__phase = 'pre';
  w.__writes = [];
  w.__winTouchEnd = 0;
  window.addEventListener('touchend', () => (w.__winTouchEnd = (w.__winTouchEnd as number) + 1), {
    capture: true
  });
  const isBox = (el: Element | null) => !!el?.classList?.contains('cyc-message-list-scroll');
  const rec = (v: unknown) => {
    if (w.__rigWrite) return;
    w.__writes.push({phase: w.__phase, v: typeof v === 'number' ? Math.round(v) : 0});
  };
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    enumerable: d.enumerable,
    get: d.get,
    set(v: number) {
      if (isBox(this)) rec(v);
      d.set!.call(this, v);
    }
  });
  for (const m of ['scrollTo', 'scroll', 'scrollBy'] as const) {
    const o = Element.prototype[m] as (...a: unknown[]) => void;
    (Element.prototype as unknown as Record<string, unknown>)[m] = function (
      this: Element,
      ...a: unknown[]
    ) {
      if (isBox(this)) rec(a[0]);
      return o.apply(this, a);
    };
  }
  const siv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, ...a: unknown[]) {
    if (this.closest?.('.cyc-message-list-scroll')) rec(a[0]);
    return siv.apply(this, a as never);
  };
};

const ownerState = (page: Page) =>
  page.evaluate(
    () =>
      (window as never as {__cycScrollDiag: () => {ownerState: string}}).__cycScrollDiag()
        .ownerState
  );

const dist = (page: Page) =>
  page.evaluate((sel) => {
    const b = document.querySelector(sel) as HTMLElement;
    return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
  }, SCROLL);

const writesIn = (page: Page, phase: string) =>
  page.evaluate(
    (phase) =>
      (window as never as {__writes: {phase: string}[]}).__writes.filter((x) => x.phase === phase)
        .length,
    phase
  );

const setPhase = (page: Page, p: string) =>
  page.evaluate((p) => ((window as never as {__phase: string}).__phase = p), p);

// The reader's own scroll: the offset moves (the rig's write, not counted) and
// the scroll event plus a wheel (reader input) land, as the matrix rig does.
const readerScroll = (page: Page, dy: number) =>
  page.evaluate(
    ({sel, dy}) => {
      const w = window as never as {__rigWrite: boolean};
      const b = document.querySelector(sel) as HTMLElement;
      w.__rigWrite = true;
      b.scrollTop = Math.max(0, Math.min(b.scrollHeight - b.clientHeight, b.scrollTop + dy));
      w.__rigWrite = false;
      b.dispatchEvent(new Event('scroll'));
      b.dispatchEvent(new Event('wheel'));
    },
    {sel: SCROLL, dy}
  );

async function open(page: Page, eng: ScrollEngine, v: {width: number; height: number}) {
  await page.addInitScript(WRITE_HOOK);
  await bootPinned(page, eng.port, {size: {width: v.width, height: v.height}});
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await page.waitForSelector(INPUT);
  await page.waitForTimeout(1500);
}

// The finger lands on the last row, the reader scrolls far up (the row
// unmounts), the finger lifts (`lift` delivers the touchend to the detached
// row), the reader scrolls back to the end, then 3 replies arrive.
async function detachedLift(page: Page, eng: ScrollEngine, lift: () => Promise<void>) {
  for (let i = 0; i < 8; i++) {
    await readerScroll(page, -900);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  const connectedAtLift = await page.evaluate(
    () => (window as never as {__touchRow: Element}).__touchRow.isConnected
  );
  const winBefore = await page.evaluate(
    () => (window as never as {__winTouchEnd: number}).__winTouchEnd
  );
  await lift();
  await page.waitForTimeout(300);
  const windowGotTouchEnd =
    (await page.evaluate(() => (window as never as {__winTouchEnd: number}).__winTouchEnd)) -
    winBefore;
  for (let i = 0; i < 12; i++) {
    await readerScroll(page, 900);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  const stateAfterLift = await ownerState(page);
  const dists: number[] = [];
  for (let i = 0; i < 3; i++) {
    eng.say('arrival after the lift ' + i + ' with enough words to wrap a little');
    await page.waitForTimeout(700);
    dists.push(await dist(page));
  }
  const r = {
    connectedAtLift,
    windowGotTouchEnd,
    stateAfterLift,
    dists,
    stateEnd: await ownerState(page)
  };
  test.info().annotations.push({type: 'owner lets go', description: JSON.stringify(r)});
  return r;
}

for (const v of VIEWPORTS) {
  test.describe(`owner lets go ${v.key}`, () => {
    test.use({hasTouch: true, isMobile: v.key === 'phone', timezoneId: 'UTC', locale: 'en-US'});

    test('a finger whose row unmounts before the lift still releases (synthetic touch)', async ({
      page
    }) => {
      const eng = await startScrollEngine({count: 300, lines: LONG});
      try {
        await open(page, eng, v);
        await page.evaluate((sel) => {
          const b = document.querySelector(sel) as HTMLElement;
          const rows = b.querySelectorAll<HTMLElement>('.cyc-message[data-mid]');
          const row = rows[rows.length - 1];
          const t = row.querySelector<HTMLElement>('p,span,div') || row;
          (window as never as {__touchRow: Element}).__touchRow = t;
          t.dispatchEvent(new Event('touchstart', {bubbles: true}));
        }, SCROLL);
        // The browser delivers the lift to the ORIGINAL target, detached or not.
        const r = await detachedLift(page, eng, () =>
          page.evaluate(() => {
            (window as never as {__touchRow: Element}).__touchRow.dispatchEvent(
              new Event('touchend', {bubbles: true})
            );
          })
        );
        expect(r.connectedAtLift, 'the rig must detach the touched row').toBe(false);
        expect(r.windowGotTouchEnd, 'a detached target keeps its touchend from the window').toBe(0);
        expect(r.stateAfterLift).not.toBe('reader-driving');
        for (const d of r.dists)
          expect(d, `pinned reader follows each reply: ${r.dists}`).toBeLessThanOrEqual(2);
      } finally {
        await eng.close();
      }
    });

    test('a finger whose row unmounts before the lift still releases (real touch, Chromium)', async ({
      page,
      browserName
    }) => {
      test.skip(browserName !== 'chromium', 'CDP touch is Chromium only');
      const eng = await startScrollEngine({count: 300, lines: LONG});
      try {
        await open(page, eng, v);
        const cdp = await page.context().newCDPSession(page);
        const pt = await page.evaluate((sel) => {
          const b = document.querySelector(sel) as HTMLElement;
          const rows = b.querySelectorAll<HTMLElement>('.cyc-message[data-mid]');
          const row = rows[rows.length - 1];
          const r = row.getBoundingClientRect();
          (window as never as {__touchRow: Element}).__touchRow = row;
          return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + Math.min(20, r.height / 2))
          };
        }, SCROLL);
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [pt]});
        await page.waitForTimeout(100);
        const r = await detachedLift(page, eng, async () => {
          await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        });
        expect(r.connectedAtLift, 'the rig must detach the touched row').toBe(false);
        expect(r.windowGotTouchEnd, 'a detached target keeps its touchend from the window').toBe(0);
        expect(r.stateAfterLift).not.toBe('reader-driving');
        for (const d of r.dists)
          expect(d, `pinned reader follows each reply: ${r.dists}`).toBeLessThanOrEqual(2);
      } finally {
        await eng.close();
      }
    });

    test('momentum through 90-270 ms frames is still the reader: nothing writes until it stops', async ({
      page
    }) => {
      const eng = await startScrollEngine({
        count: 600,
        eventsEvery: 6,
        imageEvery: 13,
        lines: LONG
      });
      try {
        await open(page, eng, v);
        await setPhase(page, 'finger');
        await page.evaluate((sel) => {
          (document.querySelector(sel) as HTMLElement).dispatchEvent(
            new Event('touchstart', {bubbles: true})
          );
        }, SCROLL);
        // An upward drag under the finger: rows mount and re-measure, so the
        // re-window has corrections to bank.
        for (let i = 0; i < 30; i++) {
          await page.evaluate((sel) => {
            const w = window as never as {__rigWrite: boolean};
            const b = document.querySelector(sel) as HTMLElement;
            w.__rigWrite = true;
            b.scrollTop = Math.max(0, b.scrollTop - 400);
            w.__rigWrite = false;
            b.dispatchEvent(new Event('touchmove', {bubbles: true}));
          }, SCROLL);
          await page.waitForTimeout(30);
        }
        const fling = await page.evaluate(
          ({sel, gaps}) =>
            new Promise<{gaps: number[]; driving: string[]}>((done) => {
              const w = window as never as {
                __rigWrite: boolean;
                __phase: string;
                __cycScrollDiag: () => {ownerState: string};
              };
              const b = document.querySelector(sel) as HTMLElement;
              let flinging = true;
              const swallow = (e: Event) => {
                if (flinging) e.stopImmediatePropagation();
              };
              window.addEventListener('scrollend', swallow, {capture: true});
              window.dispatchEvent(new Event('touchend'));
              w.__phase = 'momentum';
              const seen: number[] = [];
              const states: string[] = [];
              let last = performance.now();
              b.addEventListener('scroll', () => {
                const now = performance.now();
                seen.push(Math.round(now - last));
                last = now;
              });
              let i = 0;
              const step = () => {
                states.push(w.__cycScrollDiag().ownerState);
                if (i === gaps.length) {
                  // The fling stops: the browser's one scrollend for it.
                  flinging = false;
                  window.removeEventListener('scrollend', swallow, {capture: true});
                  w.__phase = 'after';
                  b.dispatchEvent(new Event('scrollend'));
                  return done({gaps: seen, driving: states});
                }
                w.__rigWrite = true;
                b.scrollTop = Math.max(0, b.scrollTop - Math.max(8, 60 - i * 3));
                w.__rigWrite = false;
                setTimeout(step, gaps[i++]);
              };
              step();
            }),
          {sel: SCROLL, gaps: FLING_GAPS}
        );
        const momentumWrites = await writesIn(page, 'momentum');
        const fingerWrites = await writesIn(page, 'finger');
        await page.waitForTimeout(800);
        const after = {writes: await writesIn(page, 'after'), state: await ownerState(page)};
        const r = {
          fingerWrites,
          momentumWrites,
          after,
          scrollGaps: fling.gaps,
          states: fling.driving
        };
        test.info().annotations.push({type: 'owner lets go', description: JSON.stringify(r)});
        expect(
          Math.max(...fling.gaps.slice(2)),
          'the fling had frames past 150 ms'
        ).toBeGreaterThan(150);
        expect(fingerWrites, 'no write under the finger').toBe(0);
        expect(momentumWrites, `no write while momentum runs: ${JSON.stringify(r)}`).toBe(0);
        expect(
          fling.driving.every((s) => s === 'reader-driving'),
          `driving through the fling: ${fling.driving}`
        ).toBe(true);
        // Once it stops the owner lets go (and may release its bank in one write).
        expect(after.state).not.toBe('reader-driving');
        expect(after.writes).toBeLessThanOrEqual(2);
      } finally {
        await eng.close();
      }
    });
  });
}
