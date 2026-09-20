import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {
  comeBack,
  goOffline,
  heldMessages,
  intentRows,
  openChat,
  sidOf,
  typeAndSend,
  waitLive
} from './offlineKit';

// Head-of-line blocking and reconnect replay (offline design v2, F1/F2, lane B
// round 6). The drain held one send in flight per ENGINE, so a send whose ack
// never came froze the whole engine's queue -- another session's send and every
// read mark waited behind it. And the reconnect replay resent every ack-timeout
// rewrite, so one cid went out N+1 times. These specs drive both against the
// chat rig, live: the rig holds a session's ack (a stuck send), fails a send to
// a dead pane on its cid, and models the reconnect the way the real engine does.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const A = 'alpha';
const B = 'bravo';
const NAME: Record<string, string> = {[A]: 'Alpha Relay', [B]: 'Bravo Metrics'};
const BASE = 1_700_000_000_000;
const SIZE = {width: 1280, height: 900};

function twoSessions(): Promise<ChatEngine> {
  return startChatEngine({
    sessions: [
      {id: A, name: NAME[A], messages: seedMessages(A, 5, BASE)},
      {id: B, name: NAME[B], messages: seedMessages(B, 5, BASE + 1_000_000)}
    ]
  });
}

const statusOf = (page: Page, sid: string, text: string) =>
  heldMessages(page, sid).then((m) => m.find((x) => x.text === text)?.status);

async function bootOpen(page: Page, engine: ChatEngine, name: string) {
  await bootPinned(page, engine.port, {size: SIZE});
  await openChat(page, name);
  await waitLive(page);
  await expect
    .poll(() => heldMessages(page, sidOf(engine.port, name === NAME[A] ? A : B)).then((m) => m.length), {
      timeout: 15_000
    })
    .toBeGreaterThan(0);
}

// The row menu on desktop: right-click, then "Mark as unread".
async function markUnread(page: Page, name: string) {
  const r = page.locator('.cyc-session-entry', {hasText: name}).first();
  await r.click({button: 'right'});
  const item = page.locator('.cyc-menu-item', {hasText: 'Mark as unread'}).first();
  await item.waitFor({state: 'visible', timeout: 10_000});
  await item.click();
}

test('F1: a stuck send to A does not hold B; B sends and lands', async ({page}) => {
  test.setTimeout(120_000);
  const engine = await twoSessions();
  try {
    await bootOpen(page, engine, NAME[A]);
    const sidA = sidOf(engine.port, A);
    const sidB = sidOf(engine.port, B);

    // A's ack is held: its send reaches the engine and sits there, taken and
    // unanswered -- the stuck head the old drain would have queued B behind.
    engine.holdAcksForPane(A);
    await typeAndSend(page, 'stuck on A');
    await expect
      .poll(() => engine.utterances.filter((u) => u.text === 'stuck on A').length, {timeout: 10_000})
      .toBe(1);
    await expect.poll(() => statusOf(page, sidA, 'stuck on A'), {timeout: 5_000}).toBe('sending');

    // B, on the same engine, sends and lands while A is still stuck.
    await openChat(page, NAME[B]);
    await typeAndSend(page, 'B lands');
    await expect.poll(() => statusOf(page, sidB, 'B lands'), {timeout: 15_000}).toBe('delivered');
    expect(engine.delivered.size, 'B was delivered, A was not').toBe(1);

    // A's send is still stuck: the fix freed B, it did not free A.
    expect(await statusOf(page, sidA, 'stuck on A')).toBe('sending');
    expect((await intentRows(page)).filter((i) => i.kind === 'send-text' && i.state !== 'failed')).toHaveLength(1);

    // Releasing A's ack now delivers it too, so nothing was lost.
    engine.releaseAcks(A);
    await expect.poll(() => statusOf(page, sidA, 'stuck on A'), {timeout: 15_000}).toBe('delivered');
  } finally {
    await engine.close();
  }
});

test('F1: a read mark on B lands while a send to A is stuck', async ({page}) => {
  test.setTimeout(120_000);
  const engine = await twoSessions();
  try {
    await bootOpen(page, engine, NAME[A]);
    const sidA = sidOf(engine.port, A);

    engine.holdAcksForPane(A);
    await typeAndSend(page, 'stuck again');
    await expect
      .poll(() => engine.utterances.filter((u) => u.text === 'stuck again').length, {timeout: 10_000})
      .toBe(1);
    await expect.poll(() => statusOf(page, sidA, 'stuck again'), {timeout: 5_000}).toBe('sending');

    // The read-state mark on B (a non-send intent) drains past the stuck send:
    // the old single-slot drain would have held it behind A's frozen ack.
    await markUnread(page, NAME[B]);
    await expect
      .poll(() => engine.unreadOf(B), {timeout: 15_000, message: 'the read mark never reached the engine'})
      .toBe(1);
    expect(engine.posts.some((p) => p.path === `/session/${B}/unread`)).toBe(true);

    // A's send is still stuck: the read mark passed it, it did not unstick it.
    expect(await statusOf(page, sidA, 'stuck again')).toBe('sending');
  } finally {
    await engine.close();
  }
});

test('F1: a send that drains to a dead pane fails on the row with the engine reason', async ({
  page
}) => {
  test.setTimeout(120_000);
  const engine = await twoSessions();
  try {
    await bootOpen(page, engine, NAME[A]);
    const sidA = sidOf(engine.port, A);

    // Queue the send while the engine is away (offline-first: the composer
    // still takes it), so the frame goes out only when the engine returns.
    await goOffline(page, engine);
    await openChat(page, NAME[A]);
    await typeAndSend(page, 'into a dead pane');
    await expect
      .poll(() => intentRows(page).then((r) => r.filter((i) => i.kind === 'send-text').length), {
        timeout: 10_000
      })
      .toBe(1);

    // The pane is dead by the time the engine is back: the queued send drains
    // to it and the engine fails it on its cid.
    engine.setAlive(A, false);
    await comeBack(page, engine);

    // The row goes failed with the reason on it, not a positive ack and a grey
    // bubble; nothing was delivered.
    await expect.poll(() => statusOf(page, sidA, 'into a dead pane'), {timeout: 20_000}).toBe('failed');
    const row = (await heldMessages(page, sidA)).find((m) => m.text === 'into a dead pane');
    expect(row?.failReason).toContain('offline');
    const note = page.locator('.cyc-send-failed', {hasText: 'offline'});
    await expect(note.first()).toBeVisible({timeout: 10_000});
    expect(engine.delivered.size).toBe(0);
    // The row is kept, owed again on the retry tap (its intent stays).
    expect((await intentRows(page)).filter((i) => i.kind === 'send-text')).toHaveLength(1);
  } finally {
    await engine.close();
  }
});

test('F2: three ack timeouts then a reconnect does not replay once per rewrite', async ({page}) => {
  test.setTimeout(150_000);
  const engine = await twoSessions();
  try {
    await bootOpen(page, engine, NAME[A]);
    const sidA = sidOf(engine.port, A);
    // A short ack deadline so three timeouts fire quickly.
    await page.evaluate(() => {
      (window as unknown as {__cycAckTimeoutMs: number}).__cycAckTimeoutMs = 400;
    });

    // The engine takes the send and never acks: the app rewrites it at each
    // deadline, same cid. Three rewrites -> four writes at the engine.
    engine.holdAcksForPane(A);
    await typeAndSend(page, 'rewritten');
    await expect
      .poll(() => engine.utterances.filter((u) => u.text === 'rewritten').length, {
        timeout: 30_000,
        message: 'the frame was not rewritten on the ack deadline'
      })
      .toBeGreaterThanOrEqual(4);
    const cid = engine.utterances.find((u) => u.text === 'rewritten')!.cid;
    const gen0 = engine.gen;
    // Four writes so far (the send and three rewrites), all one cid.
    const before = engine.utterances.filter((u) => u.cid === cid).length;
    expect(before).toBeGreaterThanOrEqual(4);
    expect(new Set(engine.utterances.filter((u) => u.cid === cid).map((u) => u.cid)).size).toBe(1);

    // The pipe drops and comes back (a fresh generation). The client's unacked
    // set now holds ONE frame per cid, not one per rewrite, so the reconnect
    // replay does not scale with the number of timeouts: at most the durable
    // intent's own re-send and the one unacked replay, never the N+1 the bug
    // put back. The engine dedups by cid, so the pane still sees it once.
    await engine.stop();
    await page.waitForTimeout(500);
    await engine.start();
    await waitLive(page, 30_000);
    await expect.poll(() => statusOf(page, sidA, 'rewritten'), {timeout: 20_000}).toBe('delivered');

    const replayed = engine.utterances.filter((u) => u.cid === cid && u.gen >= engine.gen).length;
    expect(replayed).toBeGreaterThanOrEqual(1);
    expect(replayed, 'the reconnect replayed once per ack-timeout rewrite').toBeLessThanOrEqual(2);
    expect(replayed, 'the reconnect replay did not shrink below the pre-drop writes').toBeLessThan(before);
    expect(engine.gen).toBeGreaterThan(gen0);
    expect(engine.msgs(A).filter((m) => m.text === 'rewritten')).toHaveLength(1);
  } finally {
    await engine.close();
  }
});
