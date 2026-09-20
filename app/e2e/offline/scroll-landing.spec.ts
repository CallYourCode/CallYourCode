import {expect, test, type Page} from '@playwright/test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {bootPinned, PAGE} from './rig';
import {runningAgent, SESSION_NAME, startScrollEngine, type ScrollEngine} from './scrollEngine';

// OPENING LANDS AT THE BOTTOM OR THE FIRST UNREAD, NEVER MID-WAY (the scrolling
// lane, defect 2). The owner: "the scroll opens the conversation at random
// middle points". Every way of opening a chat (cold, warm re-open, after a
// reload, with unread lines, a very long history with images whose height is
// only known once the bytes arrive) must land the view at the very bottom, or
// with the unread marker in the top third, and STAY there: growth that lands
// after the pin (image bytes, late rows) must not move the view.
//
// Each way is driven ten times at phone width. Every assertion is a
// boundingBox: the last row against the composer, or the unread marker against
// the scroller's top edge, at the landing and again 1.5 s later.
// grep token: `scroll landing`.

test.use({hasTouch: true, timezoneId: 'UTC', locale: 'en-US'});

const PHONE = {width: 390, height: 844};
const ROUNDS = 10;
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';
const COMPOSER = '#cyc-thread-pane .cyc-composer-main';
const OUT = process.env.CYC_SCROLL_PROBE_OUT;

type Landing = {
  at: string;
  rows: number;
  gap: number;
  distToEnd: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  // The unread marker's offset from the scroller's top edge, or null.
  markerTop: number | null;
  trace: {ms: number; top: number; dist: number}[];
};

async function landing(page: Page, at: string): Promise<Landing> {
  return page.evaluate(
    ({scrollSel, composerSel, at}) => {
      const scroll = document.querySelector(scrollSel) as HTMLElement;
      const composer = document.querySelector(composerSel) as HTMLElement;
      const rows = scroll.querySelectorAll<HTMLElement>('.cyc-message');
      const last = rows[rows.length - 1];
      const lastBottom = last ? last.getBoundingClientRect().bottom : 0;
      const composerTop = composer.getBoundingClientRect().top;
      const marker = scroll.querySelector<HTMLElement>('[data-cyc-unread]');
      const scrollTop0 = scroll.getBoundingClientRect().top;
      const w = window as unknown as {__cycScrollTrace?: {ms: number; top: number; dist: number}[]};
      return {
        at,
        rows: rows.length,
        gap: Math.round(composerTop - lastBottom),
        distToEnd: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
        scrollTop: Math.round(scroll.scrollTop),
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        markerTop: marker ? Math.round(marker.getBoundingClientRect().top - scrollTop0) : null,
        trace: (w.__cycScrollTrace ?? []).slice()
      };
    },
    {scrollSel: SCROLL, composerSel: COMPOSER, at}
  );
}

// Records every scroll event on the message scroller from the moment the chat
// pane exists, so a landing that moved and came back still shows.
async function armTrace(page: Page) {
  await page.evaluate((sel) => {
    const w = window as unknown as {
      __cycScrollTrace?: {ms: number; top: number; dist: number}[];
      __cycScrollTraceEl?: HTMLElement;
    };
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    if (w.__cycScrollTraceEl === el) {
      w.__cycScrollTrace = [];
      return;
    }
    w.__cycScrollTraceEl = el;
    w.__cycScrollTrace = [];
    const t0 = performance.now();
    el.addEventListener(
      'scroll',
      () => {
        w.__cycScrollTrace!.push({
          ms: Math.round(performance.now() - t0),
          top: Math.round(el.scrollTop),
          dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
        });
      },
      {passive: true}
    );
  }, SCROLL);
}

async function waitRows(page: Page) {
  await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.querySelectorAll('.cyc-message').length ?? 0) > 0,
    SCROLL,
    {timeout: 15_000}
  );
}

// Opens the long thread from the list, then samples the landing at the first
// paint, 300 ms later (the landing pin has run by then), and at 1.5 s.
async function openAndSample(page: Page, label: string): Promise<Landing[]> {
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await waitRows(page);
  await armTrace(page);
  const out: Landing[] = [];
  out.push(await landing(page, `${label} first-paint`));
  await page.waitForTimeout(300);
  out.push(await landing(page, `${label} +300`));
  await page.waitForTimeout(1200);
  out.push(await landing(page, `${label} +1500`));
  return out;
}

async function backToList(page: Page) {
  await page.locator('.cyc-mast .cyc-pane-back').first().click();
  await page.waitForSelector('#cyc-columns[data-view="list"]');
  await page.waitForSelector('.cyc-session-entry');
}

function record(name: string, samples: Landing[]) {
  if (!OUT) return;
  mkdirSync(OUT, {recursive: true});
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(samples, null, 2));
}

// The bottom landing: the last row sits above the composer and the list is at
// its end, both at +300 and at +1500.
function expectBottom(samples: Landing[], why: string) {
  for (const g of samples.slice(1)) {
    expect(g.rows, `${why} [${g.at}]: no rows`).toBeGreaterThan(0);
    expect(g.distToEnd, `${why} [${g.at}]: the list is not at its end`).toBeLessThanOrEqual(2);
    expect(g.gap, `${why} [${g.at}]: the last row is under the composer`).toBeGreaterThanOrEqual(0);
  }
}

// The unread landing: the marker is inside the top half of the scroller (its
// headroom is a third of the height), or the list is at its end when the unread
// tail is shorter than the viewport; and it has not moved by +1500.
function expectUnread(samples: Landing[], why: string) {
  for (const g of samples.slice(1)) {
    expect(g.markerTop, `${why} [${g.at}]: no unread marker`).not.toBeNull();
    const inHeadroom = g.markerTop! >= 0 && g.markerTop! <= g.clientHeight / 2;
    expect(
      inHeadroom || g.distToEnd <= 2,
      `${why} [${g.at}]: marker at ${g.markerTop} of ${g.clientHeight}, dist ${g.distToEnd}`
    ).toBe(true);
  }
  const a = samples[1];
  const b = samples[2];
  expect(Math.abs(a.markerTop! - b.markerTop!), `${why}: the marker moved after the landing`).toBeLessThanOrEqual(2);
}

async function bootAndOpen(page: Page, eng: ScrollEngine) {
  await bootPinned(page, eng.port, {size: PHONE});
}

test('scroll landing: a warm re-open lands at the bottom ten times', async ({page}) => {
  test.setTimeout(120_000);
  const eng = await startScrollEngine({count: 120, imageEvery: 6, imageDelayMs: 350});
  const all: Landing[] = [];
  try {
    await bootAndOpen(page, eng);
    for (let i = 0; i < ROUNDS; i++) {
      const s = await openAndSample(page, `warm#${i}`);
      all.push(...s);
      expectBottom(s, `warm re-open ${i}`);
      await backToList(page);
    }
  } finally {
    record('warm-bottom', all);
    await eng.close();
  }
});

test('scroll landing: a cold open after a reload lands at the bottom ten times', async ({page}) => {
  test.setTimeout(150_000);
  const eng = await startScrollEngine({count: 120, imageEvery: 6, imageDelayMs: 350});
  const all: Landing[] = [];
  try {
    await bootAndOpen(page, eng);
    for (let i = 0; i < ROUNDS; i++) {
      if (i) {
        // A fresh page: the app boots again, restores the chat it had open, and
        // the round starts from the list like the first one did.
        await page.goto(`${PAGE}/?testhooks=1&v=${Date.now()}`);
        await waitRows(page);
        await backToList(page);
      }
      const s = await openAndSample(page, `cold#${i}`);
      all.push(...s);
      expectBottom(s, `cold open ${i}`);
    }
  } finally {
    record('cold-bottom', all);
    await eng.close();
  }
});

test('scroll landing: a reload with the chat open lands at the bottom ten times', async ({page}) => {
  test.setTimeout(150_000);
  const eng = await startScrollEngine({count: 120, imageEvery: 6, imageDelayMs: 350});
  const all: Landing[] = [];
  try {
    await bootAndOpen(page, eng);
    await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
    await waitRows(page);
    for (let i = 0; i < ROUNDS; i++) {
      await page.reload();
      await waitRows(page);
      await armTrace(page);
      const s: Landing[] = [await landing(page, `reload#${i} first-paint`)];
      await page.waitForTimeout(300);
      s.push(await landing(page, `reload#${i} +300`));
      await page.waitForTimeout(1200);
      s.push(await landing(page, `reload#${i} +1500`));
      all.push(...s);
      expectBottom(s, `reload ${i}`);
    }
  } finally {
    record('reload-bottom', all);
    await eng.close();
  }
});

test('scroll landing: opening with unread lines lands on the marker ten times', async ({page}) => {
  test.setTimeout(150_000);
  const eng = await startScrollEngine({count: 120, imageEvery: 6, imageDelayMs: 350});
  const all: Landing[] = [];
  try {
    await bootAndOpen(page, eng);
    for (let i = 0; i < ROUNDS; i++) {
      // Enough unread agent lines that the marker sits well above the bottom.
      eng.setUnread(12);
      await page.waitForTimeout(150);
      const s = await openAndSample(page, `unread#${i}`);
      all.push(...s);
      expectUnread(s, `unread open ${i}`);
      await backToList(page);
    }
  } finally {
    record('unread-marker', all);
    await eng.close();
  }
});

// The agents bar floats over the top of the list and reserves 3.25rem of top
// pad while a subagent runs. The app hides it on every fresh open and polls the
// engine right after, so the pad grows back a few frames AFTER the landing.
// That growth shifts every row down; the landing must absorb it.

// Hides the bar for the next round: the engine answers no runs and the app
// polls on a visibility change while the chat is still open.
async function hideAgentsBar(page: Page, eng: ScrollEngine) {
  eng.setAgentRuns([]);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(
    () =>
      (document.querySelector('#cyc-thread-pane .cyc-message-list-pad-top') as HTMLElement).offsetHeight <
      100
  );
}

const padTop = (page: Page) =>
  page.evaluate(
    () => (document.querySelector('#cyc-thread-pane .cyc-message-list-pad-top') as HTMLElement).offsetHeight
  );

test('scroll landing: one unread line with the agents bar arriving after the landing lands at the bottom ten times', async ({
  page
}) => {
  test.setTimeout(150_000);
  const eng = await startScrollEngine({count: 120, imageEvery: 6, imageDelayMs: 350});
  const all: Landing[] = [];
  try {
    await bootAndOpen(page, eng);
    for (let i = 0; i < ROUNDS; i++) {
      eng.setUnread(1);
      eng.setAgentRuns([runningAgent(i + 1)]);
      await page.waitForTimeout(150);
      const s = await openAndSample(page, `unread1-bar#${i}`);
      all.push(...s);
      expect(await padTop(page), `round ${i}: the agents bar must be up`).toBeGreaterThan(100);
      expectBottom(s, `one unread line, agents bar late ${i}`);
      await hideAgentsBar(page, eng);
      await backToList(page);
    }
  } finally {
    record('unread1-bar-bottom', all);
    await eng.close();
  }
});

test('scroll landing: unread lines with the agents bar arriving after the landing keep the marker ten times', async ({
  page
}) => {
  test.setTimeout(150_000);
  const eng = await startScrollEngine({count: 120, imageEvery: 6, imageDelayMs: 350});
  const all: Landing[] = [];
  try {
    await bootAndOpen(page, eng);
    for (let i = 0; i < ROUNDS; i++) {
      eng.setUnread(12);
      eng.setAgentRuns([runningAgent(i + 1)]);
      await page.waitForTimeout(150);
      const s = await openAndSample(page, `unread12-bar#${i}`);
      all.push(...s);
      expect(await padTop(page), `round ${i}: the agents bar must be up`).toBeGreaterThan(100);
      expectUnread(s, `unread lines, agents bar late ${i}`);
      // The marker sits where the landing put it: a third of the way down,
      // not a bar's height lower.
      for (const g of s.slice(1)) {
        expect(g.markerTop!, `[${g.at}]: the marker slid down under the late top pad`).toBeLessThanOrEqual(
          g.clientHeight / 3 + 16
        );
      }
      await hideAgentsBar(page, eng);
      await backToList(page);
    }
  } finally {
    record('unread12-bar-marker', all);
    await eng.close();
  }
});

test('scroll landing: a very long history with late images lands at the bottom ten times', async ({
  page
}) => {
  test.setTimeout(240_000);
  const eng = await startScrollEngine({count: 600, imageEvery: 5, imageDelayMs: 400});
  const all: Landing[] = [];
  try {
    await bootAndOpen(page, eng);
    for (let i = 0; i < ROUNDS; i++) {
      const s = await openAndSample(page, `long#${i}`);
      all.push(...s);
      expectBottom(s, `long history open ${i}`);
      await backToList(page);
    }
  } finally {
    record('long-bottom', all);
    await eng.close();
  }
});
