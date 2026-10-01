import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, startScrollEngine} from './scrollEngine';

// SCROLLING A CONVERSATION IS WEIRDLY JITTERY (owner, iPhone, Safari home-screen
// PWA, 2026-10-01: an upward hand/momentum scroll up through cached history).
//
// PROVEN cause (field app.log dev=726ju + measured in _explore and here): while
// the reader's finger/momentum carries the list UP, anchoredRewindow keeps
// WRITING scrollTop to hold its top anchor as rows above the fold re-measure
// (the field saw `rewindow.anchor` writing +911/+251 and bouncing scrollTop by
// ~200px per frame, ctx=user -- i.e. against the reader's own scroll). The scroll
// box is `overflow-anchor:none`, so that compensation is load-bearing on every
// platform; but on iOS WebKit a programmatic scrollTop write during a touch or
// momentum scroll interrupts the momentum and jumps. So the very writes meant to
// hold content steady are what the owner felt as jitter.
//
// This spec drives a real upward TOUCH drag (CDP Input.dispatchTouchEvent) on a
// long chat whose rows measure far from EST_MSG, and counts, while a finger is
// down: (1) PROGRAMMATIC scrollTop writes (an assignment runs the JS setter;
// native/compositor scrolling does not), and (2) frames where scrollTop moved
// AGAINST the upward fling (rose) -- the view lurching back the way the reader
// did not push. Before the fix both are large (~400 writes, ~30 reversals);
// after, both are zero: the list holds measured rows' heights stable while
// scrolling and defers the one-step compensation to the scroll-end settle, so
// nothing writes scrollTop under the reader's finger. grep token: `scroll jitter`.

test.use({hasTouch: true, isMobile: true, timezoneId: 'UTC', locale: 'en-US'});

const INPUT = '#cyc-thread-pane .cyc-composer-input';
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';
const PHONE = {width: 390, height: 844};

// Shapes (not content) from the real BZ Distributor chat: a wide spread of
// wrapped-bubble heights, many rows far taller than EST_MSG (96). Short acks,
// medium questions, long multi-paragraph replies.
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
    return (
      'The batch cursor advances only after the ack lands, so a dropped ack ' +
      'rewinds the whole page. '.repeat(4)
    );
  return (
    `Reply ${i}: ` +
    'the pool now hands each worker its own allocation and returns it on close, ' +
    'so two workers never contend for the same slot. '.repeat(8)
  );
}

type Probe = {
  writesDuringTouch: number;
  reversals: number;
  maxAgainst: number;
  movedUp: number;
  distinctMids: number;
};

async function instrument(page: Page) {
  await page.evaluate((sel) => {
    const box = document.querySelector(sel) as HTMLElement;
    const w = window as unknown as Record<string, unknown>;
    w.__touch = false;
    w.__writes = 0;
    w.__frames = [];
    box.addEventListener('touchstart', () => (w.__touch = true), {passive: true});
    window.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!e.touches || e.touches.length === 0) w.__touch = false;
      },
      {passive: true}
    );
    window.addEventListener('touchcancel', () => (w.__touch = false), {passive: true});

    // Count PROGRAMMATIC scrollTop writes while a finger is down. An assignment
    // to box.scrollTop runs this setter; native/compositor scrolling does not.
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
        if (w.__touch) w.__writes = (w.__writes as number) + 1;
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

// A sustained upward touch drag: the finger moves DOWN the screen (y grows),
// which reveals older messages and drops scrollTop -- a scroll up through the
// cached history, by real CDP touch events (proven to move the box).
async function dragUp(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(PHONE.width / 2);
  let y = 150;
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
  for (let i = 0; i < 240; i++) {
    y += 45;
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y}]});
    await page.waitForTimeout(6);
    if (y > 780) {
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      y = 150;
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    }
  }
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await page.waitForTimeout(200);
}

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__sampling = false;
    const frames = w.__frames as {top: number; mid: string | null; touch: boolean}[];
    // The fling is UP (scrollTop decreasing). A reversal is scrollTop rising
    // between two finger-down frames: the view lurching back against the reader.
    let reversals = 0;
    let maxAgainst = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (!a.touch || !b.touch) continue;
      const d = b.top - a.top;
      if (d > 2) {
        reversals++;
        if (d > maxAgainst) maxAgainst = d;
      }
    }
    const tops = frames.map((f) => f.top);
    return {
      writesDuringTouch: w.__writes as number,
      reversals,
      maxAgainst: Math.round(maxAgainst),
      movedUp: Math.round(Math.max(...tops) - Math.min(...tops)),
      distinctMids: new Set(frames.map((f) => f.mid)).size
    };
  });
}

test('scroll jitter: an upward fling writes no scrollTop under the finger and never lurches back', async ({
  page
}) => {
  test.setTimeout(120_000);
  const eng = await startScrollEngine({count: 220, lineText: (i) => variedLine(i)});
  try {
    await bootPinned(page, eng.port, {size: PHONE});
    await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
    await page.waitForSelector(INPUT);
    // Let the open land at the bottom and settle before the drag.
    await page.waitForTimeout(1200);

    await instrument(page);
    await dragUp(page);
    const probe = await readProbe(page);
    test.info().annotations.push({type: 'scroll-jitter', description: JSON.stringify(probe)});

    // The fling actually scrolled up through history (so the measurements below
    // mean something, not a drag that never moved).
    expect(probe.movedUp, 'the drag never moved the view up through history').toBeGreaterThan(
      PHONE.height
    );
    expect(probe.distinctMids, 'the visible row never changed under the drag').toBeGreaterThan(10);

    // The proven cause and its signature: no programmatic scrollTop write while a
    // finger drives the scroll, and the view never lurches back against the fling.
    expect(
      probe.writesDuringTouch,
      'the app wrote scrollTop under the reader finger (interrupts iOS momentum)'
    ).toBe(0);
    expect(probe.reversals, 'the view lurched back against the upward fling').toBe(0);
  } finally {
    await eng.close();
  }
});
