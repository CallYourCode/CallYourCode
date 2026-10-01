import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, startScrollEngine} from './scrollEngine';

// SCROLLING A CONVERSATION IS WEIRDLY JITTERY (owner, iPhone, Safari home-screen
// PWA, 2026-10-01). His usual move is flicking UP FROM THE BOTTOM of a cached
// conversation. Field app.log dev=726ju caught `rewindow.anchor` writing +911 /
// +251 under his scroll.
//
// PROVEN cause (field log + the measurements this spec makes): the scroll box is
// `overflow-anchor:none`, so holding content steady while rows above the fold
// re-measure is load-bearing on every platform. The app did that by WRITING
// scrollTop (anchoredRewindow). On iOS WebKit a programmatic scrollTop write
// during a touch or momentum scroll interrupts the momentum and jumps, so the
// very writes meant to hold content steady are what the owner felt as jitter.
//
// Two distinct regressions this spec pins, each with the gesture that exposes it:
//
//  (A) UNDER THE FINGER / DURING MOMENTUM, the list must write NO scrollTop. On
//      `main` an upward drag makes anchoredRewindow compensate every re-measured
//      row with a scrollTop write -- a burst of large against-the-fling writes
//      (the jitter). This spec drives four real touch gestures and asserts zero
//      programmatic scrollTop writes while a finger is down, and no large write
//      during momentum. `main` fails (the write burst); fef729d's own fix made
//      the sustained drag clean here.
//
//  (B) THE SETTLED OPEN MUST MEASURE ITS FULL HEIGHT. fef729d held EVERY mounted
//      row at its estimate while isScrolling, INCLUDING during the open landing
//      at the bottom, so the settled open under-measured total height (rows
//      cached at EST_MSG whose real height never committed). A viewport resize
//      forces those rows to re-measure and the height jumps up by the deficit.
//      fef729d fails (the height heals on resize); `main` and the fix do not
//      (they measured the landing correctly, so there is nothing to heal). This
//      under-measure is what the ungated bottom pin then chased under the owner's
//      first flick up from the bottom.
//
// A programmatic scrollTop assignment runs the JS setter; native/compositor
// scrolling does not, so a wrapped setter counts exactly the app's own writes.
// grep token: `scroll jitter`.

test.use({hasTouch: true, isMobile: true, timezoneId: 'UTC', locale: 'en-US'});

const INPUT = '#cyc-thread-pane .cyc-composer-input';
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';
const PHONE = {width: 390, height: 844};

// A write after the finger lifts is the ONE clean scroll-end compensation the
// fix defers to the settle (isScrolling cleared); it is small and isolated. A
// write BIGGER than this, after the lift, is a momentum-time write (the jitter).
const SETTLE_MAX_PX = 60;
// A resize that grows the settled height by more than this exposes a landing
// that under-measured (rows held at their estimate). fef729d grows ~2200px here;
// a correct landing grows 0.
const UNDER_MEASURE_PX = 150;

// Shapes (not content) from the real BZ Distributor chat: a wide spread of
// wrapped-bubble heights, many rows FAR taller than EST_MSG (96). Short acks,
// medium questions, long multi-paragraph replies -- so the measure-driven
// re-window has real deltas to compensate for, and a landing that held rows at
// EST_MSG under-measures by a large, reliable amount (the deficit scales with
// how far the real bubbles sit from the estimate, so the tall buckets repeat a
// whole sentence rather than a fragment).
function variedLine(i: number): string {
  const bucket = i % 5;
  if (bucket === 0) return 'ok';
  if (bucket === 1) return 'thanks, that makes sense to me now';
  if (bucket === 2)
    return (
      'Can you check why the third worker keeps re-reading the same page and ' +
      'whether the cursor is being advanced after each batch is acknowledged?'
    );
  if (bucket === 3)
    return 'The batch cursor advances only after the ack lands, so a dropped ack rewinds the whole page. '.repeat(
      4
    );
  return (
    `Reply ${i}: ` +
    'the pool now hands each worker its own allocation and returns it on close, so two workers never contend for the same slot. '.repeat(
      8
    )
  );
}

type Write = {sinceLift: number | null; touch: boolean; d: number};
type Probe = {
  writes: Write[];
  movedUp: number;
  distinctMids: number;
  reversals: number;
  maxReversal: number;
};

// Wrap the scroll box's scrollTop setter (counts the app's own writes, with the
// finger-down state at the time) and sample the topmost-visible row per frame so
// the drag's reach and any visible lurch are measured too.
async function instrument(page: Page) {
  await page.evaluate((sel) => {
    const box = document.querySelector(sel) as HTMLElement;
    const w = window as unknown as Record<string, unknown>;
    w.__touch = false;
    w.__lastLift = null;
    w.__writes = [];
    w.__frames = [];
    box.addEventListener('touchstart', () => (w.__touch = true), {passive: true});
    window.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!e.touches || e.touches.length === 0) {
          w.__touch = false;
          w.__lastLift = performance.now();
        }
      },
      {passive: true}
    );
    window.addEventListener('touchcancel', () => (w.__touch = false), {passive: true});

    let desc: PropertyDescriptor | undefined;
    for (let p = Object.getPrototypeOf(box); p && !desc; p = Object.getPrototypeOf(p))
      desc = Object.getOwnPropertyDescriptor(p, 'scrollTop') ?? undefined;
    if (!desc || !desc.get || !desc.set) throw new Error('no scrollTop descriptor');
    const get = desc.get;
    const set = desc.set;
    Object.defineProperty(box, 'scrollTop', {
      configurable: true,
      get() {
        return get.call(box);
      },
      set(v: number) {
        const from = get.call(box);
        (w.__writes as Write[]).push({
          sinceLift: w.__lastLift ? Math.round(performance.now() - (w.__lastLift as number)) : null,
          touch: w.__touch as boolean,
          d: Math.round(v - from)
        });
        set.call(box, v);
      }
    });

    w.__sampling = true;
    const tick = () => {
      if (!w.__sampling) return;
      const r = box.getBoundingClientRect();
      let mid: string | null = null;
      for (const row of box.querySelectorAll<HTMLElement>('.cyc-message[data-mid]')) {
        if (row.getBoundingClientRect().top >= r.top - 0.5) {
          mid = row.dataset.mid ?? null;
          break;
        }
      }
      (w.__frames as unknown[]).push({top: get.call(box), mid, touch: w.__touch});
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SCROLL);
}

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__sampling = false;
    const frames = w.__frames as {top: number; mid: string | null; touch: boolean}[];
    // The fling is UP (scrollTop decreasing as older history reveals). A reversal
    // is scrollTop RISING between two consecutive finger-down frames: the view
    // lurching back the way the reader did not push -- the visible jitter. With
    // no programmatic write under the finger the native scroll is monotonic, so
    // this is ~0; the compensation writes on `main` show up here as large rises.
    let reversals = 0;
    let maxReversal = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (!a.touch || !b.touch) continue;
      const d = b.top - a.top;
      if (d > 2) {
        reversals++;
        if (d > maxReversal) maxReversal = d;
      }
    }
    const tops = frames.map((f) => f.top);
    return {
      writes: w.__writes as {sinceLift: number | null; touch: boolean; d: number}[],
      movedUp: Math.round(Math.max(...tops) - Math.min(...tops)),
      distinctMids: new Set(frames.map((f) => f.mid)).size,
      reversals,
      maxReversal: Math.round(maxReversal)
    };
  });
}

// A real upward TOUCH drag by CDP. The finger moves DOWN the screen (y grows),
// which reveals older messages and drops scrollTop -- scrolling up through the
// cached history. `pauseEveryMs` drops in a pause after each move (the slow drag
// the owner also does); `reset` restarts the drag from the top when the finger
// runs off the screen (the sustained drag).
async function drag(
  page: Page,
  o: {startY: number; step: number; moves: number; gapMs: number; reset?: boolean}
) {
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(PHONE.width / 2);
  let y = o.startY;
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
  for (let i = 0; i < o.moves; i++) {
    y += o.step;
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y}]});
    await page.waitForTimeout(o.gapMs);
    if (o.reset && y > 780) {
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      y = o.startY;
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    }
  }
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await page.waitForTimeout(900);
}

async function openPinned(page: Page, port: number) {
  await bootPinned(page, port, {size: PHONE});
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await page.waitForSelector(INPUT);
  // Let the open land at the bottom and settle before the gesture.
  await page.waitForTimeout(1200);
}

// The four gestures the owner reported, each a different exposure of the same
// fault: the first flick up from the bottom, a long fling, a slow drag with
// pauses, and the original fast sustained drag. All must write nothing under the
// finger and nothing large during momentum.
const GESTURES: {name: string; drag: Parameters<typeof drag>[1]; minMove: number}[] = [
  {
    name: 'the first flick up from the bottom',
    drag: {startY: 300, step: 30, moves: 6, gapMs: 8},
    minMove: 150
  },
  {name: 'a long fling', drag: {startY: 200, step: 45, moves: 14, gapMs: 6}, minMove: 400},
  {
    name: 'a slow drag with pauses',
    drag: {startY: 300, step: 40, moves: 7, gapMs: 400},
    minMove: 200
  },
  {
    name: 'the original fast sustained drag',
    drag: {startY: 150, step: 45, moves: 240, gapMs: 6, reset: true},
    minMove: PHONE.height
  }
];

for (const g of GESTURES) {
  test(`scroll jitter: ${g.name} writes no scrollTop under the finger or during momentum`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const eng = await startScrollEngine({count: 220, lineText: (i) => variedLine(i)});
    try {
      await openPinned(page, eng.port);
      await instrument(page);
      await drag(page, g.drag);
      const probe = await readProbe(page);
      test.info().annotations.push({
        type: 'scroll-jitter',
        description: JSON.stringify({
          gesture: g.name,
          underFinger: probe.writes.filter((x) => x.touch).length,
          afterLift: probe.writes.filter((x) => !x.touch).length,
          maxUnderFinger: Math.max(0, ...probe.writes.filter((x) => x.touch).map((x) => Math.abs(x.d))),
          maxAfterLift: Math.max(0, ...probe.writes.filter((x) => !x.touch).map((x) => Math.abs(x.d))),
          movedUp: probe.movedUp,
          reversals: probe.reversals,
          maxReversal: probe.maxReversal
        })
      });

      // The drag actually scrolled up through history (so the measurements mean
      // something, not a gesture that never moved the view).
      expect(probe.movedUp, 'the drag never moved the view up through history').toBeGreaterThan(
        g.minMove
      );
      // A tall bubble can stay the topmost row across a short flick, so the
      // movedUp floor above is the real "it scrolled" gate; this only confirms
      // the sampler saw a row at all.
      expect(probe.distinctMids, 'the sampler saw no row under the drag').toBeGreaterThan(0);

      // (A) No programmatic scrollTop write while a finger drives the scroll:
      // anchoredRewindow's anchor write is gated on isScrolling and its bottom
      // pin on readerDriving, so neither fires under the finger.
      const underFinger = probe.writes.filter((x) => x.touch);
      expect(
        underFinger.length,
        `wrote scrollTop under the reader's finger (interrupts iOS momentum): ${JSON.stringify(underFinger)}`
      ).toBe(0);

      // No large write during momentum: the only write allowed after the lift is
      // the single small scroll-end compensation (the deferred re-window). A
      // larger write means the app chased the content under momentum.
      const bigAfterLift = probe.writes.filter((x) => !x.touch && Math.abs(x.d) > SETTLE_MAX_PX);
      expect(
        bigAfterLift.length,
        `wrote scrollTop during momentum: ${JSON.stringify(bigAfterLift)}`
      ).toBe(0);

      // The visible content never lurched back more than a few px under the
      // finger (the native up-fling is monotonic when nothing writes scrollTop).
      expect(
        probe.maxReversal,
        `the visible content lurched back against the fling (${probe.reversals} frames)`
      ).toBeLessThanOrEqual(16);
    } finally {
      await eng.close();
    }
  });
}

test('scroll jitter: the settled open measures its full height (no under-measure the bottom pin can chase)', async ({
  page
}) => {
  test.setTimeout(120_000);
  const eng = await startScrollEngine({count: 220, lineText: (i) => variedLine(i)});
  try {
    await openPinned(page, eng.port);
    const h0 = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement).scrollHeight,
      SCROLL
    );
    // Shrink the viewport hard and restore it: the virtualizer re-measures every
    // mounted row on the resize (isScrolling false). A landing that held its rows
    // at their estimate under-measured, so the real heights commit here and the
    // total jumps up by the deficit; a landing that measured correctly does not
    // move. (A tiny resize can short-circuit the re-measure, so the shrink is
    // large.) This is the under-measure the ungated bottom pin chased under the
    // owner's first flick up from the bottom.
    await page.setViewportSize({width: PHONE.width, height: 620});
    await page.waitForTimeout(600);
    await page.setViewportSize({width: PHONE.width, height: PHONE.height});
    await page.waitForTimeout(600);
    const h1 = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement).scrollHeight,
      SCROLL
    );
    test.info().annotations.push({
      type: 'scroll-jitter',
      description: JSON.stringify({openHeight: h0, afterResize: h1, grew: h1 - h0})
    });
    expect(
      Math.abs(h1 - h0),
      `the settled open under-measured by ${h1 - h0}px (rows held at their estimate); the bottom pin chases this under the finger`
    ).toBeLessThanOrEqual(UNDER_MEASURE_PX);
  } finally {
    await eng.close();
  }
});
