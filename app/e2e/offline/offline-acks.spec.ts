import {test, expect, type Page} from '@playwright/test';
import {PAGE, bootPinned} from './rig';
import {startChatEngine, seedEvents, seedMessages, type ChatEngine} from './chatEngine';
import {
  LAYOUTS,
  backToList,
  captureLog,
  heldMessages,
  intentRows,
  openChat,
  pageBack,
  sidOf,
  typeAndSend,
  waitLive
} from './offlineKit';

// Offline design v2, section 10, tests 12 to 16: the ack path (A1 zombie
// outbox, A2 late echo and lost ack), the warm open that replays nothing
// (A3), and the liveness probe (A9). All against the chat rig, live.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const A = 'alpha';
const NAME = 'Alpha Relay';
const BASE = 1_700_000_000_000;

function rig(o: {messages?: number; events?: number} = {}): Promise<ChatEngine> {
  return startChatEngine({
    sessions: [
      {
        id: A,
        name: NAME,
        messages: seedMessages(A, o.messages ?? 5, BASE),
        events: seedEvents(A, o.events ?? 0, BASE)
      }
    ]
  });
}

const statusOf = (page: Page, sid: string, text: string) =>
  heldMessages(page, sid).then((m) => m.find((x) => x.text === text)?.status);

const userBubbles = (page: Page, text: string) =>
  page
    .locator('.cyc-message-list-inner .cyc-message:not(.cyc-msg-system)', {hasText: text})
    .count();

async function bootOpen(page: Page, engine: ChatEngine, size: {width: number; height: number}) {
  await bootPinned(page, engine.port, {size});
  await openChat(page, NAME);
  await waitLive(page);
  await expect
    .poll(() => heldMessages(page, sidOf(engine.port, A)).then((m) => m.length), {timeout: 15_000})
    .toBeGreaterThan(0);
}

for (const {layout, size} of LAYOUTS) {
  test(`12 A1 a send lost with the engine is delivered once after a reload (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await bootOpen(page, engine, size);
      const sid = sidOf(engine.port, A);

      // The rig drops this utterance and dies in the same breath: no ack.
      engine.dropNextUtterance();
      await typeAndSend(page, 'lost');
      await engine.stop();
      await expect
        .poll(() => intentRows(page).then((r) => r.filter((i) => i.kind === 'send-text').length), {
          timeout: 10_000
        })
        .toBe(1);
      const cid = String((await intentRows(page))[0].payload.cid);
      expect(engine.utterances.filter((u) => u.cid === cid).length).toBeLessThanOrEqual(1);
      expect(engine.delivered.has(cid)).toBe(false);

      await page.reload();
      await engine.start();
      const gen = engine.gen;
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await expect
        .poll(() => engine.utterances.filter((u) => u.cid === cid && u.gen === gen).length, {
          timeout: 10_000,
          message: 'the lost send never reached the engine'
        })
        .toBe(1);
      await expect.poll(() => intentRows(page).then((r) => r.length), {timeout: 10_000}).toBe(0);
      // The reload restored the chat (the phone hides the list behind it).
      await backToList(page, layout);
      await openChat(page, NAME);
      await expect.poll(() => statusOf(page, sid, 'lost'), {timeout: 15_000}).toBe('delivered');
      await expect.poll(() => userBubbles(page, 'lost')).toBe(1);
      expect(engine.utterances.filter((u) => u.cid === cid && u.gen === gen)).toHaveLength(1);
      expect(engine.msgs(A).filter((m) => m.text === 'lost')).toHaveLength(1);

      // The migration path: the same row as a legacy outbox row marked
      // `failed` becomes a queued send intent on the v5 -> v6 upgrade.
      await engine.stop();
      await page.goto(`${PAGE}/__legacy_outbox__`);
      await page.evaluate(
        ({sessionId}) =>
          new Promise<void>((res, rej) => {
            const del = indexedDB.deleteDatabase('cyc-clips');
            del.onerror = () => rej(del.error);
            del.onblocked = () => rej(new Error('cyc-clips delete blocked'));
            del.onsuccess = () => {
              const open = indexedDB.open('cyc-clips', 5);
              open.onerror = () => rej(open.error);
              open.onupgradeneeded = () => {
                const d = open.result;
                d.createObjectStore('clips', {keyPath: 'key'});
                d.createObjectStore('compositions', {keyPath: 'sessionId'});
                d.createObjectStore('images', {keyPath: 'url'});
                d.createObjectStore('transfers', {keyPath: 'key'});
                d.createObjectStore('outbox', {keyPath: 'cid'});
              };
              open.onsuccess = () => {
                const d = open.result;
                const tx = d.transaction('outbox', 'readwrite');
                tx.objectStore('outbox').put({
                  cid: 'legacy-cid-1',
                  sessionId,
                  ts: Date.now(),
                  text: 'lost-legacy',
                  kind: 'text',
                  wire: 'lost-legacy',
                  status: 'failed',
                  attempts: 2
                });
                tx.oncomplete = () => {
                  d.close();
                  res();
                };
                tx.onerror = () => rej(tx.error);
              };
            };
          }),
        {sessionId: sid}
      );
      await engine.start();
      const gen2 = engine.gen;
      await page.goto(`${PAGE}/?testhooks=1&v=${Date.now()}`);
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await expect
        .poll(
          () => engine.utterances.filter((u) => u.cid === 'legacy-cid-1' && u.gen === gen2).length,
          {timeout: 10_000, message: 'the legacy outbox row never drained'}
        )
        .toBe(1);
      await expect.poll(() => intentRows(page).then((r) => r.length), {timeout: 10_000}).toBe(0);
      await backToList(page, layout);
      await openChat(page, NAME);
      await expect
        .poll(() => statusOf(page, sid, 'lost-legacy'), {timeout: 15_000})
        .toBe('delivered');
      expect(engine.utterances.filter((u) => u.cid === 'legacy-cid-1')).toHaveLength(1);
      expect(engine.msgs(A).filter((m) => m.text === 'lost-legacy')).toHaveLength(1);
    } finally {
      await engine.close();
    }
  });

  test(`13 A2 a late echo leaves the bubble sent, never failed, then delivered (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    const log = captureLog(page);
    try {
      await bootOpen(page, engine, size);
      const sid = sidOf(engine.port, A);
      engine.holdEcho(15_000);
      const sentAt = Date.now();
      await typeAndSend(page, 'late');
      await expect
        .poll(() => statusOf(page, sid, 'late'), {timeout: 1000, intervals: [50]})
        .toBe('sent');
      const seen = new Set<string>();
      let deliveredAt = 0;
      while (Date.now() - sentAt < 20_000) {
        const st = await statusOf(page, sid, 'late');
        if (st) seen.add(st);
        if (st === 'delivered') {
          deliveredAt = Date.now();
          break;
        }
        await page.waitForTimeout(250);
      }
      expect(seen.has('failed'), 'the bubble went failed while the echo was late').toBe(false);
      expect(deliveredAt, 'the bubble never went delivered').toBeGreaterThan(0);
      expect(deliveredAt - sentAt).toBeGreaterThanOrEqual(14_000);
      expect(deliveredAt - sentAt).toBeLessThan(18_000);
      expect(log.has('send.ack-timeout')).toBe(false);
      expect(engine.acks).toBe(1);
    } finally {
      await engine.close();
    }
  });

  test(`14 A2 a lost ack is re-written at 10 s, the dup delivers nothing (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    const log = captureLog(page);
    try {
      await bootOpen(page, engine, size);
      const sid = sidOf(engine.port, A);
      engine.dropNextAck();
      // The echo waits past the re-write so the ack path is what settles the send.
      engine.holdEcho(12_000);
      await typeAndSend(page, 'lost-ack');
      const writes = () => engine.utterances.filter((u) => u.text === 'lost-ack');
      // The clock runs from the rig's receipt of the first write (typing on
      // the phone takes its own time before that).
      await expect.poll(() => writes().length, {timeout: 5_000}).toBe(1);
      const sentAt = writes()[0].at;
      await expect
        .poll(() => writes().length, {
          timeout: 12_000,
          message: 'the frame was not written again'
        })
        .toBe(2);
      const rewroteAt = writes()[1].at;
      expect(rewroteAt - sentAt).toBeGreaterThanOrEqual(9_000);
      expect(rewroteAt - sentAt).toBeLessThan(11_000);
      const cids = new Set(writes().map((u) => u.cid));
      expect(cids.size).toBe(1);
      await expect
        .poll(() => statusOf(page, sid, 'lost-ack'), {timeout: 11_000 - (Date.now() - sentAt)})
        .toBe('sent');
      expect(Date.now() - sentAt).toBeLessThanOrEqual(11_000);
      expect(log.of('send.ack-timeout')).toHaveLength(1);
      expect(engine.acks).toBe(1);
      expect(await userBubbles(page, 'lost-ack')).toBe(1);
      expect(engine.msgs(A).filter((m) => m.text === 'lost-ack')).toHaveLength(1);
      expect(engine.delivered.size).toBe(1);
      await expect.poll(() => statusOf(page, sid, 'lost-ack'), {timeout: 15_000}).toBe('delivered');
      expect(await userBubbles(page, 'lost-ack')).toBe(1);
      expect(engine.utterances.filter((u) => u.text === 'lost-ack')).toHaveLength(2);
    } finally {
      await engine.close();
    }
  });

  test(`15 A3 a warm open paints from the cache and replays nothing (${layout})`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    const engine = await rig({messages: 1000, events: 20});
    const log = captureLog(page);
    try {
      await bootOpen(page, engine, size);
      const sid = sidOf(engine.port, A);
      for (let held = 200; held <= 1000; held += 100) await pageBack(page, sid, held);
      // The records rode in with their pages (page 0): one read path, no frame
      // of their own.
      await expect
        .poll(() => page.locator('.cyc-message.cyc-session-event').count(), {timeout: 15_000})
        .toBe(20);

      // The warm open: a reload brings the engaged chat back from the cache
      // (the same restore on both layouts) before the engine is even dialed.
      const mark = Date.now();
      const attaches = engine.attaches.length;
      await page.reload();
      await page.waitForSelector('.cyc-message-list-scroll', {timeout: 20_000});
      await expect
        .poll(() => log.since('chat.painted', mark).length, {timeout: 15_000})
        .toBeGreaterThanOrEqual(1);
      const painted = log.since('chat.painted', mark)[0];
      expect(painted.field('source')).toBe('cache');
      expect(Number(painted.field('ms'))).toBeLessThan(300);
      await waitLive(page);
      await expect.poll(() => engine.attaches.length, {timeout: 15_000}).toBe(attaches + 1);
      const attach = engine.attaches[attaches];
      expect(attach.paneId).toBe(A);
      // The records ride the pages, so a matching tail carries no cursor: the
      // app holds that page's records too and the engine resends nothing.
      expect(attach.have).toEqual({tailPage: 9, tailVersion: 1000});
      expect(attach.pages).toBe(0);
      await page.waitForTimeout(6000);
      expect(engine.attaches.length).toBe(attaches + 1);
      expect(await heldMessages(page, sid).then((m) => m.length)).toBeGreaterThanOrEqual(100);
    } finally {
      await engine.close();
    }
  });

  test(`16 A9 the probe pings a quiet pipe, a pong keeps it, no pong kills it (${layout})`, async ({
    page
  }) => {
    test.setTimeout(180_000);
    const engine = await rig();
    const log = captureLog(page);
    try {
      await bootOpen(page, engine, size);
      await page.waitForTimeout(2000);
      // Nothing inbound from here: the rig sends nothing on its own, and the
      // tunnel (the agents poll every 15 s) answers nothing.
      engine.holdTunnel();
      const attachCount = engine.attachCount;
      const mark = Date.now();
      await expect
        .poll(() => log.since('socket.probe', mark).length, {
          timeout: 35_000,
          message: 'no ping after 20 s of silence'
        })
        .toBeGreaterThanOrEqual(1);
      expect(engine.pingCount).toBeGreaterThanOrEqual(1);
      expect(engine.attachCount).toBe(attachCount);
      await page.waitForTimeout(12_000);
      expect(log.has('pipe.presumed-dead'), 'a pong did not clear the probe').toBe(false);
      expect(engine.attachCount).toBe(attachCount);

      engine.mutePings();
      const muted = Date.now();
      const pings = engine.pingCount;
      await expect
        .poll(() => log.since('pipe.presumed-dead', muted).length, {
          timeout: 45_000,
          message: 'no pong, yet the pipe was not presumed dead'
        })
        .toBe(1);
      expect(engine.pingCount).toBeGreaterThan(pings);
      const dead = log.since('pipe.presumed-dead', muted)[0];
      const probe = log.since('socket.probe', muted).pop()!;
      expect(dead.at - probe.at).toBeGreaterThanOrEqual(9_000);
      expect(dead.at - probe.at).toBeLessThan(16_000);
      engine.releaseTunnel();
    } finally {
      await engine.close();
    }
  });
  // The engine took the send and died in the same breath: the ack went down
  // with the socket and the echo never went out, so the row comes back only
  // inside a replayed page (the attach after the reload). That row and the
  // pending bubble are one message: one bubble, delivered, never a twin.
  test(`17 A2 the engine takes the send and dies before the echo; the replayed row lands in the bubble (${layout})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const engine = await rig();
    try {
      await bootOpen(page, engine, size);
      const sid = sidOf(engine.port, A);
      engine.dropNextAck();
      engine.dieAfterAck();
      await typeAndSend(page, 'ack then die');
      await expect.poll(() => engine.utterances.length, {timeout: 10_000}).toBe(1);
      expect(engine.msgs(A).filter((m) => m.text === 'ack then die')).toHaveLength(1);
      const cid = engine.utterances[0].cid;
      await expect
        .poll(() => intentRows(page).then((r) => r.filter((i) => i.kind === 'send-text').length), {
          timeout: 10_000
        })
        .toBe(1);

      await page.reload();
      await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
      await backToList(page, layout);
      await openChat(page, NAME);
      await expect.poll(() => statusOf(page, sid, 'ack then die'), {timeout: 15_000}).toBe('sending');
      expect(await userBubbles(page, 'ack then die')).toBe(1);

      await engine.start();
      await waitLive(page, 30_000);
      await expect.poll(() => intentRows(page).then((r) => r.length), {timeout: 15_000}).toBe(0);
      await expect
        .poll(() => statusOf(page, sid, 'ack then die'), {timeout: 15_000})
        .toBe('delivered');
      await page.waitForTimeout(2000);
      const bubbles = (await heldMessages(page, sid)).filter((m) => m.text === 'ack then die');
      expect(bubbles, 'the replayed row painted a twin of the pending bubble').toHaveLength(1);
      expect(bubbles[0]).toMatchObject({cid, msgId: `${A}-u5`, seq: 5, status: 'delivered'});
      expect(await userBubbles(page, 'ack then die')).toBe(1);
      expect(engine.msgs(A).filter((m) => m.text === 'ack then die')).toHaveLength(1);
      expect(engine.delivered.size).toBe(1);
      expect(engine.delivered.has(cid)).toBe(true);
    } finally {
      await engine.close();
    }
  });

  // Two tabs of the same origin, each with a send queued offline, both
  // reloaded: each tab holds both sends once, delivered; the engine holds
  // each once.
  test(`18 two tabs send offline and both reload; each holds both sends once (${layout})`, async ({
    context
  }) => {
    test.setTimeout(150_000);
    const engine = await rig();
    const a = await context.newPage();
    const b = await context.newPage();
    try {
      const sid = sidOf(engine.port, A);
      await bootOpen(a, engine, size);
      // The second tab boots into the chat the first one engaged.
      await bootPinned(b, engine.port, {size});
      await backToList(b, layout);
      await openChat(b, NAME);
      await waitLive(b);
      await engine.stop();
      for (const p of [a, b]) {
        await p.reload();
        await p.waitForSelector('.cyc-session-entry', {timeout: 20_000});
        await backToList(p, layout);
        await openChat(p, NAME);
      }
      await typeAndSend(a, 'A says');
      await typeAndSend(b, 'B says');
      await expect
        .poll(() => intentRows(a).then((r) => r.filter((i) => i.kind === 'send-text').length), {
          timeout: 10_000
        })
        .toBe(2);
      for (const p of [a, b]) {
        await p.reload();
        await p.waitForSelector('.cyc-session-entry', {timeout: 20_000});
        await backToList(p, layout);
        await openChat(p, NAME);
      }
      await engine.start();
      await waitLive(a, 30_000);
      await waitLive(b, 30_000);
      await expect.poll(() => engine.delivered.size, {timeout: 20_000}).toBe(2);
      await expect.poll(() => intentRows(a).then((r) => r.length), {timeout: 15_000}).toBe(0);
      await a.waitForTimeout(3000);
      // One drainer per origin: each send went over the wire once, not once
      // per tab.
      expect(engine.utterances.map((u) => u.text).sort()).toEqual(['A says', 'B says']);
      for (const p of [a, b]) {
        const mine = (await heldMessages(p, sid)).filter((m) => m.role === 'user');
        expect(mine.map((m) => m.text).sort(), 'a tab painted a twin').toEqual(['A says', 'B says']);
        expect(mine.map((m) => m.status)).toEqual(['delivered', 'delivered']);
        expect(await userBubbles(p, 'A says')).toBe(1);
        expect(await userBubbles(p, 'B says')).toBe(1);
      }
      expect(
        engine
          .msgs(A)
          .filter((m) => m.role === 'user')
          .map((m) => m.text)
          .sort()
      ).toEqual(['A says', 'B says']);
    } finally {
      await engine.close();
    }
  });
}
