import {expect, test, type Page} from '@playwright/test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {bootPinned} from './rig';
import {runningAgent, SESSION_NAME, startScrollEngine} from './scrollEngine';

// SENDING PINS THE VIEW TO THE BOTTOM (the scrolling lane, defect 1).
//
// The owner's report, twice on 2026-09-02: "sent that message and it went below
// the composer". The contract: after the user sends anything from the active
// chat, the sent bubble is fully visible above the composer, and the view stays
// pinned to the bottom through the composer collapsing back to one line, the
// pending -> acked -> echoed repaints, and the agent's reply, as long as the
// user has not scrolled up. If the user HAD scrolled up before sending, sending
// still brings the view to the bottom. A user who scrolled up and did not send
// is left where they are when a reply arrives.
//
// Phone viewport, touch, a long history so the list scrolls. Every assertion is
// on boundingBoxes: the last `.cyc-message` against the composer's top edge.
// grep token: `scroll pin`.

test.use({hasTouch: true, timezoneId: 'UTC', locale: 'en-US'});

const PHONE = {width: 390, height: 844};
const INPUT = '#cyc-thread-pane .cyc-composer-input';
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';
const COMPOSER = '#cyc-thread-pane .cyc-composer-main';
const OUT = process.env.CYC_SCROLL_PROBE_OUT;

type Geom = {
  at: string;
  lastBottom: number;
  composerTop: number;
  gap: number;
  distToEnd: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  lastText: string;
  rows: number;
};

async function geom(page: Page, at: string): Promise<Geom> {
  return page.evaluate(
    ({scrollSel, composerSel, at}) => {
      const scroll = document.querySelector(scrollSel) as HTMLElement;
      const composer = document.querySelector(composerSel) as HTMLElement;
      const rows = scroll.querySelectorAll<HTMLElement>('.cyc-message');
      const last = rows[rows.length - 1];
      const lastBox = last.getBoundingClientRect();
      const composerTop = composer.getBoundingClientRect().top;
      return {
        at,
        lastBottom: Math.round(lastBox.bottom),
        composerTop: Math.round(composerTop),
        gap: Math.round(composerTop - lastBox.bottom),
        distToEnd: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
        scrollTop: Math.round(scroll.scrollTop),
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        lastText: (last.textContent ?? '').slice(0, 40),
        rows: rows.length
      };
    },
    {scrollSel: SCROLL, composerSel: COMPOSER, at}
  );
}

function record(name: string, samples: Geom[]) {
  if (!OUT) return;
  mkdirSync(OUT, {recursive: true});
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(samples, null, 2));
}

// The bubble is above the composer (a positive gap) and the list is at its end.
function expectPinned(g: Geom, why: string) {
  expect(g.gap, `${why} [${g.at}]: last bubble bottom ${g.lastBottom} vs composer top ${g.composerTop}`).toBeGreaterThanOrEqual(0);
  expect(g.distToEnd, `${why} [${g.at}]: the list is not at its end`).toBeLessThanOrEqual(2);
}

async function openLong(page: Page, port: number) {
  await bootPinned(page, port, {size: PHONE});
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await page.waitForSelector(INPUT);
  // Let the open settle (landing + the settle grace) before driving the composer.
  await page.waitForTimeout(1200);
}

async function typeThreeLines(page: Page, tag: string) {
  await page.locator(INPUT).click();
  await page.keyboard.type(`first line ${tag}`);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line goes here');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('third line ends it');
  await page.waitForTimeout(250);
}

// The phone sends with a tap on the send button (pointerdown/pointerup), not
// with the Enter key.
async function tapSend(page: Page) {
  await page.locator('#cyc-thread-pane .cyc-send-btn').tap();
}

async function sampleAfterSend(page: Page, name: string): Promise<Geom[]> {
  const samples: Geom[] = [];
  samples.push(await geom(page, 't+0'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
  samples.push(await geom(page, 't+raf'));
  for (const ms of [100, 400, 800, 1500]) {
    await page.waitForTimeout(ms === 100 ? 100 : ms - (ms === 400 ? 100 : ms === 800 ? 400 : 800));
    samples.push(await geom(page, `t+${ms}`));
  }
  record(name, samples);
  return samples;
}

test('scroll pin (a): a 3-line send from a grown composer lands the bubble above the composer', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startScrollEngine({count: 80, echoDelayMs: 0});
  try {
    await openLong(page, eng.port);
    const before = await geom(page, 'before');
    expectPinned(before, 'the open must land at the bottom before the send');

    await typeThreeLines(page, 'A');
    const grown = await geom(page, 'composer-grown');
    expect(grown.gap, 'typing three lines must not hide the last bubble').toBeGreaterThanOrEqual(0);

    await tapSend(page);
    const samples = await sampleAfterSend(page, 'a-text-send');
    for (const g of samples) expect(g.lastText).toContain('first line A');
    for (const g of samples) expectPinned(g, 'after a text send');
  } finally {
    await eng.close();
  }
});

test('scroll pin (b): the engine echo 500 ms later re-renders the bubble and the view stays pinned', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startScrollEngine({count: 80, echoDelayMs: 500});
  try {
    await openLong(page, eng.port);
    await typeThreeLines(page, 'B');
    await tapSend(page);
    const samples = await sampleAfterSend(page, 'b-echo-send');
    for (const g of samples) expect(g.lastText).toContain('first line B');
    for (const g of samples) expectPinned(g, 'after a text send with a late echo');
    await expect.poll(() => eng.utterances().length).toBe(1);
  } finally {
    await eng.close();
  }
});

test('scroll pin (c): a user two screens up sends and the view comes to the bottom', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startScrollEngine({count: 80, echoDelayMs: 300});
  try {
    await openLong(page, eng.port);
    await page.evaluate((sel) => {
      const s = document.querySelector(sel) as HTMLElement;
      s.scrollTop = s.scrollTop - 2 * s.clientHeight;
    }, SCROLL);
    await page.waitForTimeout(400);
    const up = await geom(page, 'scrolled-up');
    expect(up.distToEnd).toBeGreaterThan(up.clientHeight);

    await typeThreeLines(page, 'C');
    await tapSend(page);
    const samples = await sampleAfterSend(page, 'c-scrolled-up-send');
    for (const g of samples) expect(g.lastText).toContain('first line C');
    for (const g of samples) expectPinned(g, 'sending from a scrolled-up view');
  } finally {
    await eng.close();
  }
});

test('scroll pin (d): the agent reply arriving while pinned keeps the view at the bottom', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startScrollEngine({count: 80, echoDelayMs: 200});
  try {
    await openLong(page, eng.port);
    await typeThreeLines(page, 'D');
    await tapSend(page);
    await page.waitForTimeout(600);
    const samples: Geom[] = [];
    for (let i = 0; i < 4; i++) {
      eng.say(
        `Reply part ${i + 1}: ${'the agent keeps writing a long answer that wraps several lines on a phone. '.repeat(3)}`
      );
      await page.waitForTimeout(350);
      samples.push(await geom(page, `reply-${i + 1}`));
    }
    await page.waitForTimeout(900);
    samples.push(await geom(page, 'reply-settled'));
    record('d-reply-pinned', samples);
    for (const g of samples) expect(g.lastText).toContain('Reply part');
    for (const g of samples) expectPinned(g, 'the reply streaming in while pinned');
  } finally {
    await eng.close();
  }
});

test('scroll pin (e): a user who scrolled up is not moved by an agent reply', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startScrollEngine({count: 80});
  try {
    await openLong(page, eng.port);
    const top = await page.evaluate((sel) => {
      const s = document.querySelector(sel) as HTMLElement;
      s.scrollTop = s.scrollTop - 2 * s.clientHeight;
      return s.scrollTop;
    }, SCROLL);
    await page.waitForTimeout(400);
    eng.say('A reply the reader did not ask to be scrolled to. '.repeat(4));
    await page.waitForTimeout(700);
    const after = await page.evaluate((sel) => {
      const s = document.querySelector(sel) as HTMLElement;
      return {top: s.scrollTop, dist: s.scrollHeight - s.scrollTop - s.clientHeight};
    }, SCROLL);
    record('e-reply-held', [await geom(page, 'after-reply')]);
    expect(Math.abs(after.top - top), 'the view moved under a reader who scrolled up').toBeLessThanOrEqual(2);
    expect(after.dist).toBeGreaterThan(after.dist > 0 ? 100 : -1);
  } finally {
    await eng.close();
  }
});

// The list pads its top by the header and by the agents bar that floats over
// it (`--cyc-overlay-stack-height`, 3.25rem). When that pad grows after the
// pin, everything below it shifts down by the same amount and the sent bubble
// ends under the composer unless the view is re-pinned.

async function sampleTopGrowth(page: Page, name: string): Promise<Geom[]> {
  const samples: Geom[] = [];
  for (const ms of [100, 300, 800, 1500]) {
    await page.waitForTimeout(ms === 100 ? 100 : ms === 300 ? 200 : ms === 800 ? 500 : 700);
    samples.push(await geom(page, `t+${ms}`));
  }
  record(name, samples);
  return samples;
}

const padTop = (page: Page) =>
  page.evaluate(
    () => (document.querySelector('#cyc-thread-pane .cyc-message-list-pad-top') as HTMLElement).offsetHeight
  );

test('scroll pin (f1): the agents bar appearing after the send keeps the bubble above the composer', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startScrollEngine({count: 80, echoDelayMs: 300});
  try {
    await openLong(page, eng.port);
    await typeThreeLines(page, 'F1');
    await tapSend(page);
    const sent = await geom(page, 'sent');
    expectPinned(sent, 'right after the send');
    const padBefore = await padTop(page);

    // A subagent run reaches the app through its agents poll: the bar shows
    // over the list and reserves more top pad.
    eng.setAgentRuns([runningAgent(1)]);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const samples = await sampleTopGrowth(page, 'f1-agents-bar-after-send');
    expect(await padTop(page), 'the agents bar must have grown the top pad').toBeGreaterThan(padBefore);
    for (const g of samples) expect(g.lastText).toContain('first line F1');
    for (const g of samples) expectPinned(g, 'the agents bar appearing after the send');
  } finally {
    await eng.close();
  }
});

test('scroll pin (f2): top pad growth with no store notify keeps the bubble above the composer', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startScrollEngine({count: 80, echoDelayMs: 0});
  try {
    await openLong(page, eng.port);
    await typeThreeLines(page, 'F2');
    await tapSend(page);
    await page.waitForTimeout(300);
    const sent = await geom(page, 'sent');
    expectPinned(sent, 'right after the send');
    const padBefore = await padTop(page);

    // The same growth driven from the DOM alone (the header measuring an extra
    // toolbar row takes this path in production: a ResizeObserver sets the pad
    // variable and nothing in the store changes).
    await page.evaluate((run) => {
      const w = window as unknown as {__cycAgentsBar: {update: (runs: unknown[]) => void}};
      w.__cycAgentsBar.update([run]);
    }, runningAgent(2));
    const samples = await sampleTopGrowth(page, 'f2-top-pad-no-notify');
    expect(await padTop(page), 'the top pad must have grown').toBeGreaterThan(padBefore);
    for (const g of samples) expect(g.lastText).toContain('first line F2');
    for (const g of samples) expectPinned(g, 'top pad growth with no store notify');
  } finally {
    await eng.close();
  }
});
