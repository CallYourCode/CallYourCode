import {test, expect, type Page} from '@playwright/test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {openChat, waitLive} from './offlineKit';

// The phone-heat spec (idle-polls task). With the app open on a chat and
// untouched, nothing should reach the wire, nothing should be fetched, and the
// DOM should not repaint beyond the time labels that actually change. Hidden,
// nothing at all. This spec measures both windows through window.__cycIdle
// (timer fires, fetches, DOM mutations, long tasks) and the rig's own pipe tap
// (__cycPipeSent, app frames sent), writes the numbers to the scratch dir, and
// asserts real-but-generous ceilings.
//
// Run the "before" pass (unconverted app) with CYC_IDLE_TAG=before, which names
// the json before.json and skips the ceilings. The default pass ("after")
// asserts them.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const CHAT = 'idlechat';
const SIZE = {width: 1280, height: 900};
const TAG = process.env.CYC_IDLE_TAG === 'before' ? 'before' : 'after';
const OUT =
  process.env.CYC_IDLE_OUT ??
  '/tmp/claude-1000/-home-example-projects-personal-cyc-builder/' +
    'bd08d2c4-a425-4cfa-b849-16f83b7970f6/scratchpad/idle-polls/' +
    `idle-${TAG}.json`;

// The measurement windows, kept short enough to run inside one Playwright test
// but long enough to catch every idle timer named in the brief (10 s presence,
// 15 s agents, 20 s settings/build, 30 s/60 s list).
const VISIBLE_MS = 60_000;
const HIDDEN_MS = 30_000;

type PipeSent = {kind: string; t?: string};
type IdleSnap = {
  fires: number;
  intervalFires: number;
  timeoutFires: number;
  byDelay: Record<string, number>;
  fetches: {get: number; post: number; other: number; total: number};
  presenceFrames: number;
  mutations: number;
  longTasks: number;
  longTaskMs: number;
};
type WindowMeasure = IdleSnap & {
  // Product frames: anything the app sent that carries product intent. The
  // connection-health frames (the liveness ping/pong and the dc keepalive) are
  // split out -- they fire only because the rig is silent, and are protocol,
  // not product. The presence beat's {t:"visible"} frames are their own class
  // too: they ride the pipe sealed, so the wire tap counts them among the
  // sealed frames it cannot read into; the app counts the beats it actually
  // sent through __cycIdle.presenceFrames, and we subtract those from the
  // sealed wire total so product stays honest.
  productFrames: number;
  livenessFrames: number;
  ctrlFrames: number;
};

function oneSession(): Promise<ChatEngine> {
  // Last activity a couple of minutes ago, so the row/header carry a
  // minute-scale relative label that ticks at most once inside the window.
  const base = Date.now() - 125_000;
  return startChatEngine({
    sessions: [{id: CHAT, name: 'Idle Relay', messages: seedMessages(CHAT, 6, base)}]
  });
}

const LIVENESS_T = new Set(['ping', 'pong']);

async function pipeCounts(
  page: Page
): Promise<{product: number; liveness: number; ctrl: number}> {
  const sent = await page.evaluate(
    () => ((window as unknown as {__cycPipeSent?: PipeSent[]}).__cycPipeSent ?? []).slice()
  );
  const wire = sent.filter((s) => s.kind === 'plain' || s.kind === 'sealed');
  const liveness = wire.filter((s) => s.t !== undefined && LIVENESS_T.has(s.t)).length;
  const product = wire.length - liveness;
  const ctrl = sent.filter((s) => s.kind === 'ctrl').length;
  return {product, liveness, ctrl};
}

async function measure(page: Page, ms: number): Promise<WindowMeasure> {
  await page.evaluate(() => (window as unknown as {__cycIdle: {reset(): void}}).__cycIdle.reset());
  const pipe0 = await pipeCounts(page);
  await page.waitForTimeout(ms);
  const snap = await page.evaluate(() =>
    (window as unknown as {__cycIdle: {snapshot(): IdleSnap}}).__cycIdle.snapshot()
  );
  const pipe1 = await pipeCounts(page);
  // The sealed presence beats land in the wire tap's product bucket (their
  // inner {t:"visible"} is unreadable once sealed); lift them back out with the
  // count the app kept as it sent them.
  return {
    ...snap,
    productFrames: pipe1.product - pipe0.product - snap.presenceFrames,
    livenessFrames: pipe1.liveness - pipe0.liveness,
    ctrlFrames: pipe1.ctrl - pipe0.ctrl
  };
}

async function setVisibility(page: Page, vis: 'visible' | 'hidden'): Promise<void> {
  await page.evaluate((v) => (window as unknown as {__setVis(x: string): void}).__setVis(v), vis);
}

test('an open, idle chat stays quiet: no wire, no POSTs, no idle repaints; nothing while hidden', async ({
  page
}) => {
  test.setTimeout(180_000);
  const engine = await oneSession();
  // A mutable visibility the app reads through document.hidden /
  // visibilityState: a headless tab is always "visible", so we override the
  // getters and fire the same events the browser would.
  await page.addInitScript(() => {
    let vis = 'visible';
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => vis});
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => vis === 'hidden'});
    (window as unknown as {__setVis(x: string): void}).__setVis = (x: string) => {
      vis = x;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(x === 'hidden' ? 'blur' : 'focus'));
    };
  });
  // A live engine keeps its pipe warm: it re-broadcasts the roster on its own
  // cadence, which is what stops the app's 20 s liveness ping from firing into a
  // dead-silent socket. The rig models that with an unchanged roster every 8 s
  // (unchanged, so the app version-gates it and paints nothing). Without it the
  // only frames the idle app sends are those liveness probes -- protocol, not
  // product -- and the point of the spec is the product traffic.
  let keepalive: ReturnType<typeof setInterval> | undefined;
  try {
    await bootPinned(page, engine.port, {size: SIZE, logSends: true, extra: '&devlog=0'});
    await openChat(page, 'Idle Relay');
    await waitLive(page);
    keepalive = setInterval(() => engine.broadcastSessions(), 8000);
    // Let the boot burst (attach, first settings/build/agents reads, first
    // paints) settle before the first window opens.
    await page.waitForTimeout(4000);

    const visible = await measure(page, VISIBLE_MS);

    await setVisibility(page, 'hidden');
    await page.waitForTimeout(500);
    const hidden = await measure(page, HIDDEN_MS);
    await setVisibility(page, 'visible');

    const timers = await page.evaluate(() =>
      (window as unknown as {__cycIdle: {timers(): unknown[]}}).__cycIdle.timers()
    );

    const report = {
      tag: TAG,
      recordedAt: new Date().toISOString(),
      windows: {visibleMs: VISIBLE_MS, hiddenMs: HIDDEN_MS},
      visible,
      hidden,
      timers
    };
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`idle measure (${TAG}) -> ${OUT}\n` + JSON.stringify({visible, hidden}, null, 2));
    test.info().annotations.push({type: 'idle', description: JSON.stringify({visible, hidden})});

    if (TAG === 'before') return;

    // Visible and idle: no product frame, no POST, no GET (the polls are gone
    // or pushed onto visibility/reconnect). The liveness ping/pong and the dc
    // keepalive are protocol, not product, and are allowed.
    expect(visible.productFrames, 'a product frame left the tab while idle').toBe(0);
    expect(visible.fetches.post, 'a POST left the tab while idle').toBe(0);
    expect(visible.fetches.get, 'a GET (a poll) left the tab while idle').toBe(0);
    // The presence beat is kept: the engine's presence model needs it, so a
    // visible, idle tab still beats {t:"visible"} on its 10 s cadence -- a
    // handful over the 60 s window, and nothing else.
    expect(
      visible.presenceFrames,
      'the presence beat did not ride a visible, idle tab'
    ).toBeGreaterThanOrEqual(1);
    expect(
      visible.presenceFrames,
      'the presence beat rode a visible tab more often than its cadence allows'
    ).toBeLessThanOrEqual(8);
    // Only the changing minute label may repaint, and only its text node.
    expect(visible.mutations, 'the idle DOM repainted more than a time label').toBeLessThanOrEqual(
      12
    );

    // Hidden: no product frames, no fetches, no repaints; the tickers are
    // paused. A single connection-health keepalive may still ride the pipe.
    expect(hidden.productFrames, 'a product frame left a hidden tab').toBe(0);
    // The beat skips a hidden tab (beatOnce returns on document.hidden), so no
    // presence frame rides it either.
    expect(hidden.presenceFrames, 'the presence beat rode a hidden tab').toBe(0);
    expect(hidden.fetches.total, 'a fetch left a hidden tab').toBe(0);
    expect(hidden.mutations, 'a hidden tab repainted the DOM').toBe(0);
  } finally {
    if (keepalive) clearInterval(keepalive);
    await engine.close();
  }
});
