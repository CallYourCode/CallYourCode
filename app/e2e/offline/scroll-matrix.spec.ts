import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, startScrollEngine, type ScrollEngine} from './scrollEngine';

// THE SCROLL REDESIGN MATRIX (PHASE 1 of SCROLL-DESIGN.md).
//
// One spec, one measurement vocabulary, every scroll bug the owner hit, run in
// Chromium AND WebKit at laptop / tablet / phone. It measures only what the
// READER SEES: the first visible row's data-mid and its on-screen top per frame,
// the distance to the true end, the app's own machine scrollTop writes that land
// while a finger is down, and the history.older count. The thresholds below are
// the contract recorded in SCROLL-DESIGN.md; the per-case numbers are attached as
// annotations so the baseline table can be read off a JSON run even for the cases
// that fail on main.
//
// PORTABILITY. WebKit (GTK, headless) has no CDP touch and no reliable Touch /
// TouchEvent constructors, and no real momentum headless. So the rig never asks
// the browser to synthesise a native fling. It drives the exact inputs the app
// reads: a reader scroll is `scrollTop = x` plus a `scroll` event (untagged, so
// the app attributes it to the reader, never a machine write); a finger down is a
// bare `touchstart` on the scroller (the app's holdTouch reads no fields), lifted
// by a bare `touchend` (releaseTouch reads `touches.length`, absent on a bare
// event, so it releases); reader-input freshness is a bare `wheel`. This is the
// same primitive the committed bottom-runaway / stuck-bottom specs use, lifted to
// run identically on both engines.

const INPUT = '#cyc-thread-pane .cyc-composer-input';
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';
const COMPOSER = '#cyc-thread-pane .cyc-composer';
const BUTTON = '#cyc-thread-pane .cyc-jump-latest';

type Viewport = {key: 'laptop' | 'tablet' | 'phone'; width: number; height: number; touch: boolean};

const VIEWPORTS: Viewport[] = [
  {key: 'laptop', width: 1440, height: 900, touch: false},
  {key: 'tablet', width: 1069, height: 800, touch: true},
  {key: 'phone', width: 390, height: 844, touch: true}
];

// ---- thresholds (the contract; mirrored in SCROLL-DESIGN.md) ---------------
const T = {
  landPx: 2, // "at the bottom" / "landed" tolerance
  bandPx: 2, // a steady view wanders no more than this across frames
  jitterPx: 3, // a frame-to-frame step at/above this is jitter
  dividerSeatTolPx: 48, // the unread divider within this of its H/3 seat
  readerHoldPx: 4, // a held row's on-screen top moves no more than this
  windowRowsCap: 320 // the 300-row window plus a little slack
};

// Representative long, wrapping rows shaped like the owner's real chats (varied
// heights are what the estimate-vs-measure gap needs). Shapes only; no real
// content. The engine's own imageEvery / eventsEvery knobs add image and tool
// rows, so the seeded window mixes short acks, long prose, pills and pictures.
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

// ------------------------------------------------------------------ log tap
async function installLogTap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __cycLogCounts?: Record<string, number>;
      __cycWriteByTag?: Record<string, number>;
      __cycMaxRows?: number;
      __touchActive?: boolean;
      __pinUnderFinger?: number;
      __anchorUnderFinger?: number;
      __cycLogTap?: (e: string, f: Record<string, unknown>) => void;
    };
    const counts: Record<string, number> = {};
    const byTag: Record<string, number> = {};
    w.__cycLogCounts = counts;
    w.__cycWriteByTag = byTag;
    w.__cycMaxRows = 0;
    w.__pinUnderFinger = 0;
    w.__anchorUnderFinger = 0;
    w.__cycLogTap = (event, fields) => {
      counts[event] = (counts[event] ?? 0) + 1;
      if (event === 'chat.repaint' && typeof fields.rows === 'number')
        w.__cycMaxRows = Math.max(w.__cycMaxRows ?? 0, fields.rows as number);
      if (event === 'scroll.write' || event === 'scroll.pin') {
        const tag = String(fields.tag ?? '');
        byTag[tag] = (byTag[tag] ?? 0) + 1;
        if (w.__touchActive) {
          // A PIN write under the finger (toBottom / rewindow.bottom) is the stuck
          // signature: the view yanked to the end while a finger is down. An ANCHOR
          // write (rewindow.anchor) is the jitter signature: a compensation leap
          // under the finger. They are counted separately because stuck-bottom must
          // allow a benign anchor-hold while upward-jitter must forbid it.
          if (tag === 'toBottom' || tag === 'rewindow.bottom')
            w.__pinUnderFinger = (w.__pinUnderFinger ?? 0) + 1;
          if (tag === 'rewindow.anchor')
            w.__anchorUnderFinger = (w.__anchorUnderFinger ?? 0) + 1;
        }
      }
    };
  });
}

// A per-frame sampler of what the reader sees. Returns a disposer that resolves
// the collected frames.
async function sample(page: Page, ms: number) {
  return page.evaluate(
    ({sel, ms}) =>
      new Promise<{
        frames: {top: number; dist: number; mid: string; rowTop: number; touch: boolean}[];
      }>((done) => {
        const box = document.querySelector(sel) as HTMLElement;
        const boxTop = () => box.getBoundingClientRect().top;
        const firstVisible = () => {
          const bt = boxTop();
          for (const r of Array.from(
            box.querySelectorAll<HTMLElement>('.cyc-message[data-mid]')
          )) {
            const rect = r.getBoundingClientRect();
            if (rect.bottom > bt + 0.5) return {mid: r.dataset.mid ?? '', rowTop: Math.round(rect.top - bt)};
          }
          return {mid: '', rowTop: 0};
        };
        const w = window as unknown as {__touchActive?: boolean};
        const frames: {top: number; dist: number; mid: string; rowTop: number; touch: boolean}[] = [];
        const t0 = performance.now();
        const tick = () => {
          const fv = firstVisible();
          frames.push({
            top: Math.round(box.scrollTop),
            dist: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight),
            mid: fv.mid,
            rowTop: fv.rowTop,
            touch: !!w.__touchActive
          });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else done({frames});
        };
        requestAnimationFrame(tick);
      }),
    {sel: SCROLL, ms}
  );
}

const distToEnd = (page: Page) =>
  page.evaluate((sel) => {
    const b = document.querySelector(sel) as HTMLElement;
    return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
  }, SCROLL);

// Drive a reader scroll by `dy` px (negative = up), untagged so the app reads it
// as the reader's own. A bare wheel keeps reader-input fresh. Returns distToEnd.
async function readerScroll(page: Page, dy: number): Promise<number> {
  return page.evaluate(
    ({sel, dy}) => {
      const b = document.querySelector(sel) as HTMLElement;
      b.scrollTop = Math.max(0, Math.min(b.scrollHeight - b.clientHeight, b.scrollTop + dy));
      b.dispatchEvent(new Event('scroll'));
      b.dispatchEvent(new Event('wheel'));
      return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
    },
    {sel: SCROLL, dy}
  );
}

async function fingerDown(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const b = document.querySelector(sel) as HTMLElement;
    (window as unknown as {__touchActive?: boolean}).__touchActive = true;
    b.dispatchEvent(new Event('touchstart', {bubbles: true}));
  }, SCROLL);
}

async function fingerUp(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as {__touchActive?: boolean}).__touchActive = false;
    window.dispatchEvent(new Event('touchend'));
  });
}

async function readTapCounts(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __cycLogCounts?: Record<string, number>;
      __cycWriteByTag?: Record<string, number>;
      __cycMaxRows?: number;
      __pinUnderFinger?: number;
      __anchorUnderFinger?: number;
    };
    return {
      counts: w.__cycLogCounts ?? {},
      byTag: w.__cycWriteByTag ?? {},
      maxRows: w.__cycMaxRows ?? 0,
      pinUnderFinger: w.__pinUnderFinger ?? 0,
      anchorUnderFinger: w.__anchorUnderFinger ?? 0
    };
  });
}

// ---- commanded navigation (Hunter, iPhone, 2026-10-03) ----------------------
const CHIP = '#cyc-thread-pane .cyc-clip-jump';

// Start a spoken clip that sits ABOVE the viewport (mounted, off screen), the
// way the owner had one playing while reading at the end: a DOM click on its
// play toggle (the row is off screen, so an actionable click would scroll it
// in first). Returns the clip's msgId and the speaker state it reached.
async function playClipAbove(page: Page): Promise<{msgId: string; state: string}> {
  const msgId = await page.evaluate((sel) => {
    const b = document.querySelector(sel) as HTMLElement;
    const top = b.getBoundingClientRect().top;
    const above = Array.from(b.querySelectorAll<HTMLElement>('.cyc-clip.cyc-voice[data-msg-id]')).filter(
      (c) => c.getBoundingClientRect().bottom <= top
    );
    const clip = above[above.length - 1];
    clip?.querySelector<HTMLElement>('.cyc-clip-toggle')?.click();
    return clip?.dataset.msgId ?? '';
  }, SCROLL);
  let state = '';
  for (let i = 0; i < 30 && msgId; i++) {
    state = await page.evaluate(
      () => (window as unknown as {__cycSpeakerState: () => {state: string}}).__cycSpeakerState().state
    );
    if (state === 'speaking') break;
    await page.waitForTimeout(100);
  }
  return {msgId, state};
}

// A tap on a corner button, as a DOM click: the go-to-bottom button is
// visibility:hidden until the list leaves the end and the audio chip until a
// clip plays off screen, and an actionable click would wait on that; the
// handler is the same.
const tap = (page: Page, sel: string) =>
  page.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), sel);

// What the reader sees, sampled in a task right after each rendering update
// (the travel and the go-to-bottom walk write inside animation-frame
// callbacks, so a sample taken in one could miss the offset that was painted):
// the offset, the distance to the end, and the clip row's top against the box
// (null while it is not mounted).
async function sampleClip(page: Page, ms: number, msgId: string) {
  return page.evaluate(
    ({sel, ms, msgId}) =>
      new Promise<{t: number; top: number; dist: number; clip: number | null}[]>((done) => {
        const box = document.querySelector(sel) as HTMLElement;
        const frames: {t: number; top: number; dist: number; clip: number | null}[] = [];
        const t0 = performance.now();
        const take = () => {
          const bt = box.getBoundingClientRect().top;
          const c = msgId
            ? box.querySelector<HTMLElement>(`.cyc-clip.cyc-voice[data-msg-id="${CSS.escape(msgId)}"]`)
            : null;
          frames.push({
            t: Math.round(performance.now() - t0),
            top: Math.round(box.scrollTop),
            dist: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight),
            clip: c ? Math.round(c.getBoundingClientRect().top - bt) : null
          });
        };
        const tick = () => {
          setTimeout(take, 0);
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else setTimeout(() => done(frames), 20);
        };
        requestAnimationFrame(tick);
      }),
    {sel: SCROLL, ms, msgId}
  );
}

// Direction changes of the painted offset across frames (the fight's
// signature: two writers taking turns flip it every frame).
function reversalsOf(frames: {top: number}[]): number {
  let reversals = 0;
  let dir = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = Math.sign(frames[i].top - frames[i - 1].top);
    if (d === 0) continue;
    if (dir !== 0 && d !== dir) reversals++;
    dir = d;
  }
  return reversals;
}

// Every programmatic write to the scroller so far (scrollTop set, scrollTo):
// the app's log collapses a per-frame storm to one line, so it is counted at
// the box itself.
const writesSoFar = (page: Page) =>
  page.evaluate((sel) => {
    const b = document.querySelector(sel) as HTMLElement & {__writes?: number};
    if (b.__writes === undefined) {
      b.__writes = 0;
      const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
      Object.defineProperty(b, 'scrollTop', {
        configurable: true,
        get: () => d.get!.call(b),
        set: (v: number) => {
          b.__writes!++;
          d.set!.call(b, v);
        }
      });
      const to = b.scrollTo.bind(b);
      b.scrollTo = ((...a: never[]) => {
        b.__writes!++;
        (to as (...x: never[]) => void)(...a);
      }) as typeof b.scrollTo;
    }
    return b.__writes;
  }, SCROLL);

function jitterOf(frames: {top: number}[]): {jitterFrames: number; bandPx: number} {
  let jitterFrames = 0;
  for (let i = 1; i < frames.length; i++)
    if (Math.abs(frames[i].top - frames[i - 1].top) >= T.jitterPx) jitterFrames++;
  const tops = frames.map((f) => f.top);
  return {jitterFrames, bandPx: Math.max(...tops) - Math.min(...tops)};
}

async function annotate(type: string, payload: unknown): Promise<void> {
  test.info().annotations.push({type, description: JSON.stringify(payload)});
}

async function openPrimary(
  page: Page,
  eng: ScrollEngine,
  v: Viewport,
  opts: {unread?: number} = {}
): Promise<void> {
  await bootPinned(page, eng.port, {size: {width: v.width, height: v.height}});
  // Set unread LIVE after boot and before the open, the way the committed
  // scroll-landing spec does: an unread count that arrives in the very first
  // sessions frame takes the boot/restore path, not the open-landing path, and
  // does not mount the divider.
  if (opts.unread) {
    eng.setUnread(opts.unread);
    await page.waitForTimeout(200);
  }
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await page.waitForSelector(INPUT);
  await page.waitForTimeout(1500);
  await installLogTap(page);
}

for (const v of VIEWPORTS) {
  test.describe(`${v.key} ${v.width}x${v.height}${v.touch ? ' touch' : ''}`, () => {
    test.use(
      v.touch
        ? {hasTouch: true, isMobile: v.key === 'phone', timezoneId: 'UTC', locale: 'en-US'}
        : {timezoneId: 'UTC', locale: 'en-US'}
    );

    // CASE open-bounce (Shalu, 2026-09-29): a pinned-bottom open with unread does
    // not oscillate while overlay repaints land.
    test('open-bounce: pinned open does not oscillate under repaints', async ({page}) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 400, unread: 5, eventsEvery: 9, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        const atOpen = await distToEnd(page);
        const drive = setInterval(
          () => eng.event('tool', 'ran a check', {ts: eng.lastTs() - 5000, tool: 'Bash'}),
          2000
        );
        const {frames} = await sample(page, 12_000);
        clearInterval(drive);
        const {jitterFrames, bandPx} = jitterOf(frames);
        const tap = await readTapCounts(page);
        await annotate('open-bounce', {
          atOpen,
          jitterFrames,
          bandPx,
          scrollUpUser: tap.counts['scroll.up.user'] ?? 0,
          rewindowBottom: tap.byTag['rewindow.bottom'] ?? 0
        });
        expect(atOpen, 'open did not land at the bottom').toBeLessThanOrEqual(T.landPx);
        expect(tap.counts['scroll.up.user'] ?? 0, 'app saw an upward scroll it did not write').toBe(0);
        expect(jitterFrames, 'scrollTop jittered frame-to-frame').toBe(0);
        expect(bandPx, 'scrollTop wandered across frames').toBeLessThanOrEqual(T.bandPx);
      } finally {
        await eng.close();
      }
    });

    // CASE cannot-reach-bottom (laptop, 2026-10-01 15:54; the reverted
    // fix-scroll-jitter bistability): sitting at the end, rewindow.bottom must not
    // flip (38173<->38457 every frame) and the last rows must be reachable above
    // the composer.
    test('cannot-reach-bottom: the end is stable and the last row clears the composer', async ({
      page
    }) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 400, unread: 3, eventsEvery: 7, imageEvery: 11, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        // settle at the true end
        await page.evaluate((sel) => {
          const b = document.querySelector(sel) as HTMLElement;
          b.scrollTop = b.scrollHeight;
          b.dispatchEvent(new Event('scroll'));
        }, SCROLL);
        await page.waitForTimeout(400);
        const {frames} = await sample(page, 6000);
        const {jitterFrames, bandPx} = jitterOf(frames);
        const endGap = await page.evaluate(
          ({sel, comp}) => {
            const b = document.querySelector(sel) as HTMLElement;
            const rows = Array.from(b.querySelectorAll<HTMLElement>('.cyc-message[data-mid]'));
            const last = rows[rows.length - 1];
            const c = document.querySelector(comp) as HTMLElement;
            const compTop = c ? c.getBoundingClientRect().top : b.getBoundingClientRect().bottom;
            return {
              dist: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
              lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : -1,
              composerTop: Math.round(compTop),
              lastClears: last ? last.getBoundingClientRect().bottom <= compTop + 1 : false
            };
          },
          {sel: SCROLL, comp: COMPOSER}
        );
        const tap = await readTapCounts(page);
        await annotate('cannot-reach-bottom', {
          jitterFrames,
          bandPx,
          rewindowBottom: tap.byTag['rewindow.bottom'] ?? 0,
          ...endGap
        });
        expect(bandPx, 'the end oscillated (bistable rewindow.bottom)').toBeLessThanOrEqual(T.bandPx);
        expect(jitterFrames, 'the end jittered frame-to-frame').toBe(0);
        expect(endGap.dist, 'the view is not at the true end').toBeLessThanOrEqual(T.landPx);
        expect(endGap.lastClears, 'the last row is hidden under the composer').toBe(true);
      } finally {
        await eng.close();
      }
    });

    // CASE bottom-runaway (BZ Builder iPhone, 2026-09-30 08:24): go-to-bottom from
    // far above must not loose an older-history burst or grow the window.
    test('bottom-runaway: go-to-bottom from far above lands clean, no older burst', async ({
      page
    }) => {
      test.setTimeout(120_000);
      const eng = await startScrollEngine({count: 800, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        for (let i = 0; i < 60; i++) {
          const d = await readerScroll(page, -1200);
          await page.waitForTimeout(60);
          if (d >= 8000) break;
        }
        await page.waitForTimeout(600);
        await installLogTap(page); // reset: measure only the tap
        const distBefore = await distToEnd(page);
        // Fire the REAL go-to-bottom handler (smoothScrollToBottom, which walks to
        // the live end) via a DOM click on the FAB. The FAB is in the DOM at every
        // width but is visibility:hidden until data-cyc-godown, so a Playwright
        // actionable click hangs on it at narrow widths; a DOM .click() runs the
        // same handler regardless and is bounded. Not a one-shot scrollTo (that
        // lands short as the window re-measures and scrollHeight grows).
        const clicked = await page.evaluate((sel) => {
          const b = document.querySelector(sel) as HTMLElement | null;
          if (!b) return false;
          b.click();
          return true;
        }, BUTTON);
        expect(clicked, 'the go-to-bottom button is not in the DOM').toBe(true);
        const {frames} = await sample(page, 3500);
        await page.waitForTimeout(600);
        let big = 0;
        for (let i = 1; i < frames.length; i++)
          if (Math.abs(frames[i].top - frames[i - 1].top) >= 500) big++;
        const tap = await readTapCounts(page);
        const distAfter = await distToEnd(page);
        await annotate('bottom-runaway', {
          distBefore,
          distAfter,
          historyOlder: tap.counts['history.older'] ?? 0,
          maxRows: tap.maxRows,
          bigJumps: big
        });
        expect(distBefore, 'reader not far above the bottom').toBeGreaterThan(4000);
        expect(distAfter, 'go-to-bottom did not land at the true bottom').toBeLessThanOrEqual(T.landPx);
        expect(tap.counts['history.older'] ?? 0, 'go-to-bottom set off an older-history burst').toBe(0);
        expect(tap.maxRows, 'the model grew past its window').toBeLessThanOrEqual(T.windowRowsCap);
        expect(big, 'scrollTop jumped by 500+ px repeatedly (a runaway)').toBe(0);
      } finally {
        await eng.close();
      }
    });

    // CASE divider-freeze (BZ Distributor, 2026-09-30 08:23): after the unread
    // landing, the reader can scroll up AND back down; no machine re-seat claws the
    // view back toward the divider.
    test('divider-freeze: the reader can scroll freely after an unread landing', async ({page}) => {
      test.setTimeout(90_000);
      // A deep unread tail (set live, then opened) so the divider genuinely lands
      // off the fold and there is a divider that COULD freeze the view, not a short
      // tail that just lands at the bottom.
      const eng = await startScrollEngine({count: 600, eventsEvery: 9, lines: LONG});
      try {
        await openPrimary(page, eng, v, {unread: 12});
        await page.waitForTimeout(400);
        await installLogTap(page);
        // scroll up well clear of the landing
        let up = 0;
        for (let i = 0; i < 20; i++) up = await readerScroll(page, -900);
        await page.waitForTimeout(300);
        const {frames} = await sample(page, 2500);
        // then scroll back down
        let down = 0;
        for (let i = 0; i < 20; i++) down = await readerScroll(page, 900);
        await page.waitForTimeout(300);
        const tap = await readTapCounts(page);
        // did the view actually hold where the reader left it (no claw-back)?
        const clawBack = frames.some((f, i) => i > 0 && f.dist < frames[i - 1].dist - 200);
        await annotate('divider-freeze', {
          distAfterUp: up,
          distAfterDown: down,
          clawBack,
          anchorWrites: tap.byTag['rewindow.anchor'] ?? 0,
          dividerReseats: tap.byTag['resize.divider'] ?? 0
        });
        expect(up, 'the reader could not scroll up off the landing').toBeGreaterThan(1500);
        expect(clawBack, 'the view was clawed back toward the divider').toBe(false);
        expect(down, 'the reader could not scroll back down toward the end').toBeLessThan(up);
      } finally {
        await eng.close();
      }
    });

    // CASE stuck-at-bottom under a finger (tablet, 2026-10-01 08:49): a finger held
    // while replies stream is never re-pinned to the end by a machine write.
    test('stuck-bottom: a held finger is not re-pinned while replies stream', async ({page}) => {
      test.setTimeout(120_000);
      const eng = await startScrollEngine({count: 200, imageEvery: 5, imageDelayMs: 300, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        const atOpen = await distToEnd(page);
        await installLogTap(page);
        await fingerDown(page);
        // the reader drags up while the agent streams, finger still down
        const samplePromise = sample(page, 5000);
        for (let i = 0; i < 40; i++) {
          await readerScroll(page, -200);
          eng.say('streamed reply line ' + i + ' that wraps across the width of the bubble');
          await page.waitForTimeout(90);
        }
        const {frames} = await samplePromise;
        const reached = Math.max(...frames.map((f) => f.dist));
        // a slam-back: the view returned to the end while a finger was down after
        // the reader had cleared the bottom
        let cleared = 0;
        let slamBacks = 0;
        for (const f of frames) {
          if (f.dist > 500) cleared++;
          if (f.touch && cleared > 0 && f.dist <= 40) {
            slamBacks++;
            cleared = 0;
          }
        }
        await fingerUp(page);
        const tap = await readTapCounts(page);
        await annotate('stuck-bottom', {
          atOpen,
          reached,
          slamBacks,
          pinUnderFinger: tap.pinUnderFinger,
          toBottom: tap.byTag['toBottom'] ?? 0
        });
        expect(reached, 'the drag never moved the view off the bottom').toBeGreaterThan(v.height);
        expect(tap.pinUnderFinger, 'a machine pin wrote under the finger').toBe(0);
        expect(slamBacks, 'the view was slammed back to the bottom mid-drag').toBe(0);
      } finally {
        await eng.close();
      }
    });

    // CASE upward-jitter (iPhone, 2026-10-01 11:09): dragging up through rows that
    // mount at EST_MSG and measure taller must not write scrollTop under the finger.
    test('upward-jitter: no scrollTop writes under the finger on an upward drag', async ({page}) => {
      test.setTimeout(120_000);
      const eng = await startScrollEngine({count: 600, eventsEvery: 6, imageEvery: 13, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        await installLogTap(page);
        await fingerDown(page);
        const samplePromise = sample(page, 5000);
        for (let i = 0; i < 40; i++) {
          await readerScroll(page, -500);
          await page.waitForTimeout(80);
        }
        const {frames} = await samplePromise;
        await fingerUp(page);
        // the reader's on-screen anchor must track their drag smoothly: count
        // frames where the first-visible row jumped more than a row-height between
        // frames WITHOUT the reader asking for it (a compensation leap).
        let anchorLeaps = 0;
        for (let i = 1; i < frames.length; i++) {
          if (frames[i].mid === frames[i - 1].mid && Math.abs(frames[i].rowTop - frames[i - 1].rowTop) > 60)
            anchorLeaps++;
        }
        const tap = await readTapCounts(page);
        await annotate('upward-jitter', {
          anchorUnderFinger: tap.anchorUnderFinger,
          pinUnderFinger: tap.pinUnderFinger,
          anchorLeaps,
          anchorWrites: tap.byTag['rewindow.anchor'] ?? 0
        });
        expect(
          tap.anchorUnderFinger + tap.pinUnderFinger,
          'a machine write landed under the finger during the drag'
        ).toBe(0);
        expect(anchorLeaps, "the reader's anchor row leapt mid-drag").toBe(0);
      } finally {
        await eng.close();
      }
    });

    // CASE scrolled-up reader not moved by an arrival.
    test('arrival-held: a scrolled-up reader is not moved by an arrival', async ({page}) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 300, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        for (let i = 0; i < 10; i++) await readerScroll(page, -900);
        await page.waitForTimeout(300);
        // Anchor on a row FULLY in view (its top at least 60px below the fold), not
        // a row straddling the top edge, so the measurement is of a row the reader
        // is plainly looking at and does not flip on a sub-row wobble.
        const before = await page.evaluate((sel) => {
          const b = document.querySelector(sel) as HTMLElement;
          const bt = b.getBoundingClientRect().top;
          const r = Array.from(b.querySelectorAll<HTMLElement>('.cyc-message[data-mid]')).find(
            (x) => x.getBoundingClientRect().top - bt >= 60
          );
          return {mid: r?.dataset.mid ?? '', rowTop: r ? Math.round(r.getBoundingClientRect().top - bt) : 0};
        }, SCROLL);
        eng.say('an agent reply that arrives while the reader sits up in history');
        await page.waitForTimeout(600);
        const after = await page.evaluate(
          ({sel, mid}) => {
            const b = document.querySelector(sel) as HTMLElement;
            const bt = b.getBoundingClientRect().top;
            const el = b.querySelector<HTMLElement>(`.cyc-message[data-mid="${CSS.escape(mid)}"]`);
            return el ? Math.round(el.getBoundingClientRect().top - bt) : null;
          },
          {sel: SCROLL, mid: before.mid}
        );
        const moved = after === null ? 9999 : Math.abs(after - before.rowTop);
        await annotate('arrival-held', {mid: before.mid.slice(-8), beforeTop: before.rowTop, afterTop: after, moved});
        expect(moved, "the reader's row moved when a reply arrived").toBeLessThanOrEqual(T.readerHoldPx);
      } finally {
        await eng.close();
      }
    });

    // CASE pinned arrival lands.
    test('arrival-pinned: a pinned reader stays at the bottom on an arrival', async ({page}) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 200, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        const atOpen = await distToEnd(page);
        eng.say('a reply while pinned at the bottom');
        await page.waitForTimeout(600);
        const after = await distToEnd(page);
        await annotate('arrival-pinned', {atOpen, after});
        expect(atOpen, 'the open did not land at the bottom').toBeLessThanOrEqual(T.landPx);
        expect(after, 'a pinned arrival did not stay at the bottom').toBeLessThanOrEqual(T.landPx);
      } finally {
        await eng.close();
      }
    });

    // CASE unread landing: an unread open lands correctly and holds. The landing
    // seats the divider in the top half of the viewport when the unread tail is
    // taller than the viewport, or at the true end when it is shorter. In this
    // hermetic engine the roster carries heardTs without a mid-bearing read marker
    // and the attached chat's badge zeroes on open, so the open resolves to the
    // end-landing branch; the DIVIDER SEAT itself is covered in depth by the
    // committed scroll-landing.spec.ts (four unread cases). This case guards that
    // the unread open lands on a valid target and does not then drift, in both
    // browsers at all three viewports.
    test('unread-landing: an unread open lands correctly and holds', async ({page}) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 400, eventsEvery: 9, lines: LONG});
      try {
        await openPrimary(page, eng, v, {unread: 12});
        await page.waitForTimeout(400);
        const seat = await page.evaluate((sel) => {
          const b = document.querySelector(sel) as HTMLElement;
          const d = b.querySelector<HTMLElement>('[data-cyc-unread]');
          const dist = Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
          if (!d) return {found: false, delta: -1, half: Math.round(b.clientHeight / 2), dist};
          const delta = Math.round(d.getBoundingClientRect().top - b.getBoundingClientRect().top);
          return {found: true, delta, half: Math.round(b.clientHeight / 2), dist};
        }, SCROLL);
        const {frames} = await sample(page, 2500);
        const {bandPx} = jitterOf(frames);
        await annotate('unread-landing', {...seat, bandPx});
        // The proven landing contract (scroll-landing.spec expectUnread): the
        // divider sits in the TOP HALF of the viewport (its headroom is a third,
        // but measurement drift makes the top half the honest band), OR the unread
        // tail is shorter than the viewport and the list is at its end. And it does
        // not keep drifting after it lands.
        expect(seat.found || seat.dist <= T.landPx, 'the unread divider never mounted').toBe(true);
        if (seat.found)
          expect(
            (seat.delta >= 0 && seat.delta <= seat.half) || seat.dist <= T.landPx,
            'the divider did not land in the top half'
          ).toBe(true);
        expect(bandPx, 'the divider landing kept drifting').toBeLessThanOrEqual(T.dividerSeatTolPx);
      } finally {
        await eng.close();
      }
    });

    // CASE older-history loads only at the top.
    test('older-at-top: older history loads at the top, not on a go-to-bottom', async ({page}) => {
      test.setTimeout(120_000);
      const eng = await startScrollEngine({count: 800, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        await installLogTap(page);
        // reach the very top by hand
        for (let i = 0; i < 80; i++) {
          const top = await page.evaluate((sel) => {
            const b = document.querySelector(sel) as HTMLElement;
            b.scrollTop = Math.max(0, b.scrollTop - 1500);
            b.dispatchEvent(new Event('scroll'));
            b.dispatchEvent(new Event('wheel'));
            return b.scrollTop;
          }, SCROLL);
          await page.waitForTimeout(50);
          if (top <= 0) break;
        }
        await page.waitForTimeout(600);
        const tap = await readTapCounts(page);
        await annotate('older-at-top', {historyOlder: tap.counts['history.older'] ?? 0});
        expect(tap.counts['history.older'] ?? 0, 'reaching the top did not load older history').toBeGreaterThan(
          0
        );
      } finally {
        await eng.close();
      }
    });

    // CASE down-scroll (BZ Distributor laptop, 2026-10-03 09:40): scrolling DOWN
    // toward the end through a long run of agent lines (one message group, the
    // window opened mid-day) always moves the view down and loads no older
    // history. The field saw scrollTop thrown ~2.9k px up on each step near the
    // end (the window pruned for a layout, the browser clamped), read as the top,
    // and history.older fired 24 times while the reader never reached the end.
    test('down-scroll: scrolling down to the end moves down and loads no older history', async ({
      page
    }) => {
      test.setTimeout(120_000);
      const eng = await startScrollEngine({
        count: 600,
        eventsEvery: 9,
        agentTail: 150,
        lines: LONG
      });
      try {
        await openPrimary(page, eng, v);
        // up into the agent run, well clear of the end
        for (let i = 0; i < 6; i++) await readerScroll(page, -700);
        await page.waitForTimeout(600);
        await installLogTap(page);
        const distBefore = await distToEnd(page);
        const samplePromise = sample(page, 4000);
        let dist = distBefore;
        for (let i = 0; i < 60 && dist > T.landPx; i++) {
          dist = await readerScroll(page, 120);
          await page.waitForTimeout(40);
        }
        const {frames} = await samplePromise;
        await page.waitForTimeout(400);
        const distAfter = await distToEnd(page);
        // an upward leap the reader did not make (they only scrolled down)
        let thrownUp = 0;
        for (let i = 1; i < frames.length; i++)
          if (frames[i].top < frames[i - 1].top - 200) thrownUp++;
        const tap = await readTapCounts(page);
        await annotate('down-scroll', {
          distBefore,
          distAfter,
          thrownUp,
          historyOlder: tap.counts['history.older'] ?? 0,
          scrollUpUser: tap.counts['scroll.up.user'] ?? 0
        });
        expect(distBefore, 'the reader is not up in the agent run').toBeGreaterThan(2000);
        expect(thrownUp, 'the view was thrown up while the reader scrolled down').toBe(0);
        expect(tap.counts['history.older'] ?? 0, 'scrolling down loaded older history').toBe(0);
        expect(distAfter, 'scrolling down never reached the end').toBeLessThanOrEqual(T.landPx);
      } finally {
        await eng.close();
      }
    });

    // CASE go-to-audio while a clip plays (Hunter, iPhone, 2026-10-03: "when I
    // clicked go to audio message, it jittered like crazy"). The reader sits at
    // the end with a clip playing above; the audio chip travels to it. The
    // travel must land the clip on screen and keep it there: no other program
    // writes while it flies. Field rig (Hunter data, main, Chromium phone): the
    // travel's re-centre and the re-window's pinned-end follow wrote in turn,
    // 59 against 61 writes in one second, and the view ended back at the end.
    test('go-to-audio-playing: the audio chip lands the playing clip on screen and holds it', async ({
      page
    }) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 200, voiceEvery: 1, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        const {msgId, state} = await playClipAbove(page);
        await page.waitForTimeout(300);
        const atStart = await distToEnd(page);
        const h = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).clientHeight, SCROLL);
        const writes0 = await writesSoFar(page);
        const sampling = sampleClip(page, 2500, msgId);
        await tap(page, CHIP);
        const frames = await sampling;
        const writes = (await writesSoFar(page)) - writes0;
        // Landed: the first frame from which the clip stays on screen to the end
        // of the sample. After it, the clip must not move (a re-window
        // returning its bank moves the offset and the spacer together, so the
        // row holds still).
        const onScreen = (f: {clip: number | null}) => f.clip !== null && f.clip >= 0 && f.clip < h;
        let landedAt = -1;
        for (let i = frames.length - 1; i >= 0 && onScreen(frames[i]); i--) landedAt = i;
        let driftAfterLand = 0;
        if (landedAt >= 0) {
          // the smooth leg may still be finishing: count moves once it has stopped
          let still = landedAt;
          while (still + 1 < frames.length && frames[still + 1].clip !== frames[still].clip) still++;
          for (let i = still + 1; i < frames.length; i++)
            if (Math.abs((frames[i].clip ?? 0) - (frames[i - 1].clip ?? 0)) > T.readerHoldPx) driftAfterLand++;
        }
        // Back at the end after having left it: the pinned end pulled the travel back.
        let leftEnd = false;
        let yankedToEnd = 0;
        for (const f of frames) {
          if (f.dist > T.landPx) leftEnd = true;
          else if (leftEnd) yankedToEnd++;
        }
        const last = frames[frames.length - 1];
        await annotate('go-to-audio-playing', {
          state,
          atStart,
          landedAtMs: landedAt >= 0 ? frames[landedAt].t : -1,
          finalClipTop: last?.clip ?? null,
          finalDist: last?.dist,
          driftAfterLand,
          yankedToEnd,
          writes,
          reversals: reversalsOf(frames)
        });
        expect(msgId, 'no spoken clip was mounted above the viewport').not.toBe('');
        expect(atStart, 'the reader was not at the end when the chip was tapped').toBeLessThanOrEqual(T.landPx);
        expect(landedAt, 'the travel did not leave the playing clip on screen').toBeGreaterThanOrEqual(0);
        expect(yankedToEnd, 'the view was pulled back to the end after the travel left it').toBe(0);
        expect(driftAfterLand, 'the clip kept moving after the travel landed').toBe(0);
      } finally {
        await eng.close();
      }
    });

    // CASE go-to-bottom while a clip plays and the go-to-audio travel is still
    // in flight (Hunter, 2026-10-03: "when I hit the go to bottom button, it
    // jittered like crazy"). The newer command supersedes the travel: the view
    // goes down to the end and stays, never pulled back up toward the clip.
    // Field rig (main, WebKit phone): the travel's re-centre and the walk took
    // turns for 3.4 s, the view held at the clip against the reader's tap.
    test('go-to-bottom-playing: go-to-bottom during a go-to-audio travel lands at the end', async ({
      page
    }) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 200, voiceEvery: 1, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        const {msgId, state} = await playClipAbove(page);
        await page.waitForTimeout(300);
        await tap(page, CHIP);
        await page.waitForTimeout(60);
        const writes0 = await writesSoFar(page);
        const sampling = sampleClip(page, 3000, msgId);
        await tap(page, BUTTON);
        const frames = await sampling;
        const writes = (await writesSoFar(page)) - writes0;
        let upAfter = 0;
        for (let i = 1; i < frames.length; i++) if (frames[i].dist >= frames[i - 1].dist + T.jitterPx) upAfter++;
        let reachedAt = -1;
        let leftEnd = 0;
        for (let i = 0; i < frames.length; i++) {
          if (frames[i].dist <= T.landPx) {
            if (reachedAt < 0) reachedAt = i;
          } else if (reachedAt >= 0) leftEnd++;
        }
        const last = frames[frames.length - 1];
        await annotate('go-to-bottom-playing', {
          state,
          upAfter,
          reachedAtMs: reachedAt >= 0 ? frames[reachedAt].t : -1,
          leftEnd,
          finalDist: last?.dist,
          writes,
          reversals: reversalsOf(frames)
        });
        expect(msgId, 'no spoken clip was mounted above the viewport').not.toBe('');
        expect(upAfter, 'the view moved up after go-to-bottom (the travel pulled it back)').toBe(0);
        expect(reachedAt, 'go-to-bottom never reached the end').toBeGreaterThanOrEqual(0);
        expect(leftEnd, 'the view left the end again after reaching it').toBe(0);
        expect(last?.dist ?? 99, 'the view is not at the end').toBeLessThanOrEqual(T.landPx);
      } finally {
        await eng.close();
      }
    });

    // CASE chat switch: leaving a chat and coming back must recompute its landing
    // from scratch, carrying no leftover scroll from the view you left. The offline
    // engine serves ONE session (the seal pins every scroll engine to the same
    // user@host, so two cannot carry distinct content keys), so the switch is
    // driven on one chat whose unread state changes between visits: the first visit
    // lands at the bottom (read); after scrolling up into history and leaving, the
    // chat gains unread and the SECOND visit must land on its divider a third down,
    // not on the scrolled-up offset left behind. On a narrow phone/tablet the leave
    // is the in-app pane-back (the real switch path); on the wide laptop, which has
    // no list-only view, it is a reload re-entry. Cross-CHAT switching across many
    // real conversations is covered by the real-data rig (tools/rig/scroll-matrix.mjs).
    test('chat-switch: re-entry recomputes the landing, carrying no stale offset', async ({page}) => {
      test.setTimeout(120_000);
      const eng = await startScrollEngine({count: 300, eventsEvery: 9, lines: LONG});
      try {
        await openPrimary(page, eng, v);
        const firstDist = await distToEnd(page);
        // scroll well up into history, then leave the chat
        for (let i = 0; i < 10; i++) await readerScroll(page, -900);
        await page.waitForTimeout(200);
        const leftAt = await distToEnd(page);
        // Leave: the in-app pane-back when the layout has a list-only view (phone
        // widths), otherwise a reload re-entry (the wide two-pane laptop/tablet
        // header hides the pane-back). Both are bounded.
        const back = page.locator('.cyc-mast .cyc-pane-back').first();
        const canBack = (await back.count()) > 0 && (await back.isVisible().catch(() => false));
        if (canBack) {
          await back.click({timeout: 5000}).catch(() => {});
          await page.waitForSelector('#cyc-columns[data-view="list"]', {timeout: 6000}).catch(() => {});
        } else {
          await page.reload();
          await page.waitForSelector('.cyc-session-entry', {timeout: 15_000});
        }
        await page.waitForTimeout(300);
        // come back
        await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click({timeout: 10_000});
        await page.waitForSelector(INPUT, {timeout: 10_000});
        await page.waitForTimeout(1200);
        const reDist = await distToEnd(page);
        await annotate('chat-switch', {firstDist, leftAt, reDist, mode: canBack ? 'pane-back' : 'reload'});
        expect(firstDist, 'the first visit did not land at the bottom').toBeLessThanOrEqual(T.landPx);
        expect(leftAt, 'the reader never scrolled up off the bottom').toBeGreaterThan(2000);
        // Re-entering a read chat recomputes the landing at the bottom; it must not
        // restore the scrolled-up offset left behind.
        expect(reDist, 're-entry carried the stale scrolled-up offset').toBeLessThanOrEqual(T.landPx);
      } finally {
        await eng.close();
      }
    });
  });
}
