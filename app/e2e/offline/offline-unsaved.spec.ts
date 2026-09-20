import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startChatEngine, seedMessages, type ChatEngine} from './chatEngine';
import {startTransferEngine, CHAT, type TransferEngine} from './transferEngine';
import {
  LAYOUTS,
  backToList,
  captureLog,
  heldMessages,
  openChat,
  sidOf,
  toastCount,
  typeAndSend,
  waitLive
} from './offlineKit';

// R6: the intent row's write fails (a full store, say) while the wire is live.
// The send is in memory and still drains, so the box must not hold a copy of
// what the engine already took: the box clears once the send is on disk OR
// acked/echoed by the engine. Only a send that is neither stays in the box
// with the notice, and a press of the unchanged box meanwhile sends nothing
// new (never a second cid for one message). When the engine takes a kept
// send late, the box and the notice go then.
//
// grep token: `offline unsaved`.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const A = 'alpha';
const NAME = 'Alpha Relay';
const BASE = 1_700_000_000_000;
const INPUT = '#cyc-thread-pane .cyc-composer-input';
const VOICE = '#cyc-thread-pane .cyc-block-voice';

// Every write to the intents store throws from here on; the rest of the
// database keeps working.
async function breakIntentsStore(page: Page): Promise<void> {
  await page.evaluate(() => {
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...a: [unknown, IDBValidKey?]) {
      if (this.name === 'intents') throw new DOMException('quota', 'QuotaExceededError');
      return orig.apply(this, a);
    };
  });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  return errors;
}

async function pressEnter(page: Page): Promise<void> {
  await page.locator(INPUT).click();
  await page.keyboard.press('Enter');
}

const distinctCids = (u: {cid?: string}[]) => new Set(u.map((x) => x.cid)).size;

async function stageVoice(page: Page, size: number, text: string): Promise<void> {
  await page.evaluate(
    ({size, text}) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 7) & 0xff;
      (
        window as unknown as {
          __cycComposerAddVoice: (
            c: {durationS: number; text: string},
            b: ArrayBuffer,
            m: string
          ) => void;
        }
      ).__cycComposerAddVoice({durationS: 3, text}, bytes.buffer, 'audio/webm');
    },
    {size, text}
  );
}

const B = 'beta';
const NAME_B = 'Beta Relay';

function chatRig(two = false): Promise<ChatEngine> {
  const sessions = [{id: A, name: NAME, messages: seedMessages(A, 5, BASE)}];
  if (two) sessions.push({id: B, name: NAME_B, messages: seedMessages(B, 5, BASE)});
  return startChatEngine({sessions});
}

const boxText = (page: Page) => page.locator(INPUT).innerText();
const keptToasts = (page: Page) =>
  page.locator('.notyf__toast', {hasText: 'kept in the box'}).count();
const statusOf = (page: Page, sid: string, text: string) =>
  heldMessages(page, sid).then((m) => m.find((x) => x.text === text)?.status);
// The chat's own send for these words: painted, with a cid of its own.
const sendOf = (page: Page, sid: string, text: string) =>
  heldMessages(page, sid).then((m) => m.find((x) => x.role === 'user' && x.text === text));

// Leave the open chat for another; on the phone the list sits behind the chat.
async function switchChat(page: Page, layout: string, name: string): Promise<void> {
  await backToList(page, layout);
  await openChat(page, name);
}

async function bootChat(page: Page, engine: ChatEngine, size: {width: number; height: number}) {
  await bootPinned(page, engine.port, {size});
  await openChat(page, NAME);
  await waitLive(page);
  await expect
    .poll(() => heldMessages(page, sidOf(engine.port, A)).then((m) => m.length), {timeout: 15_000})
    .toBeGreaterThan(0);
}

for (const {layout, size} of LAYOUTS) {
  test(`R6 text, no row on disk, acked at once: the box clears, no notice, one send (${layout})`, async ({
    page
  }) => {
    const engine = await chatRig();
    const log = captureLog(page);
    const errors = watchErrors(page);
    try {
      await bootChat(page, engine, size);
      const sid = sidOf(engine.port, A);
      await breakIntentsStore(page);
      await typeAndSend(page, 'idb miss');
      await expect
        .poll(
          () => heldMessages(page, sid).then((m) => m.find((x) => x.text === 'idb miss')?.status),
          {
            timeout: 10_000
          }
        )
        .toBe('delivered');
      // Taken by the engine: the box is empty, no notice was raised.
      await expect.poll(() => page.locator(INPUT).innerText(), {timeout: 10_000}).toBe('');
      expect(log.of('send.uncommitted')).toHaveLength(1);
      expect(log.of('send.taken-unsaved')).toHaveLength(1);
      expect(await toastCount(page)).toBe(0);
      expect(distinctCids(engine.utterances)).toBe(1);
      // Enter on the empty box sends nothing new.
      await pressEnter(page);
      await page.waitForTimeout(1000);
      expect(distinctCids(engine.utterances)).toBe(1);
      expect(engine.delivered.size).toBe(1);
      expect(
        (await heldMessages(page, sid)).filter((m) => m.role === 'user' && m.text === 'idb miss')
      ).toHaveLength(1);
      expect(errors.filter((e) => /unhandled|Uncommitted/i.test(e))).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  test(`R6 text, no row on disk, ack held past the deadline: kept with the notice, Enter resends nothing, the late ack clears (${layout})`, async ({
    page
  }) => {
    const engine = await chatRig();
    const log = captureLog(page);
    const errors = watchErrors(page);
    try {
      await bootChat(page, engine, size);
      const sid = sidOf(engine.port, A);
      // A short ack deadline so the bounded wait for the engine runs out.
      await page.evaluate(() => {
        (window as unknown as {__cycAckTimeoutMs?: number}).__cycAckTimeoutMs = 1500;
      });
      engine.holdAcksAfter(0);
      await breakIntentsStore(page);
      await typeAndSend(page, 'idb miss held');
      // Neither on disk nor taken: the words stay, the notice is up.
      await expect.poll(() => log.of('send.kept').length, {timeout: 10_000}).toBe(1);
      expect(await page.locator(INPUT).innerText()).toBe('idb miss held');
      expect(log.of('send.taken-unsaved')).toHaveLength(0);
      await expect
        .poll(() => page.locator('.notyf__toast', {hasText: 'kept in the box'}).count())
        .toBe(1);
      // Enter on the kept box: no second message, no second cid.
      await pressEnter(page);
      await page.waitForTimeout(500);
      expect(log.of('send.kept-press')).toHaveLength(1);
      expect(distinctCids(engine.utterances)).toBe(1);
      expect(
        (await heldMessages(page, sid)).filter(
          (m) => m.role === 'user' && m.text === 'idb miss held'
        )
      ).toHaveLength(1);
      // The engine takes it after all: the box and the notice go.
      engine.releaseAcks();
      await expect
        .poll(
          () =>
            heldMessages(page, sid).then((m) => m.find((x) => x.text === 'idb miss held')?.status),
          {timeout: 10_000}
        )
        .toBe('delivered');
      await expect.poll(() => page.locator(INPUT).innerText(), {timeout: 10_000}).toBe('');
      expect(log.of('send.taken-late')).toHaveLength(1);
      expect(log.of('send.kept-taken').filter((l) => l.field('cleared') === 'true')).toHaveLength(
        1
      );
      await expect
        .poll(() => page.locator('.notyf__toast', {hasText: 'kept in the box'}).count())
        .toBe(0);
      expect(distinctCids(engine.utterances)).toBe(1);
      expect(engine.delivered.size).toBe(1);
      // And the box is free: a fresh Enter on the empty box sends nothing.
      await pressEnter(page);
      await page.waitForTimeout(500);
      expect(distinctCids(engine.utterances)).toBe(1);
      expect(errors.filter((e) => /unhandled|Uncommitted/i.test(e))).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  test(`R6 lone voice, no row on disk, echoed by the engine: the card leaves the box, one wire (${layout})`, async ({
    page
  }) => {
    const engine: TransferEngine = await startTransferEngine({echoUtterances: true});
    const log = captureLog(page);
    const errors = watchErrors(page);
    try {
      await bootPinned(page, engine.port, {size});
      await openChat(page, CHAT);
      await waitLive(page);
      await page.evaluate(() => {
        (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 100;
      });
      await breakIntentsStore(page);
      await stageVoice(page, 30_000, 'lone voice idb miss');
      await expect(page.locator(VOICE)).toHaveCount(1);
      await pressEnter(page);
      // The clip moves, the wire goes, the echo comes back: the card leaves.
      await expect.poll(() => engine.utterances().length, {timeout: 20_000}).toBe(1);
      await expect(page.locator(VOICE)).toHaveCount(0, {timeout: 15_000});
      expect(log.of('send.uncommitted')).toHaveLength(1);
      expect(log.of('send.taken-unsaved')).toHaveLength(1);
      expect(log.of('send.attach-failed')).toHaveLength(0);
      expect(await page.locator('.notyf__toast', {hasText: 'kept in the box'}).count()).toBe(0);
      // Enter on the empty box sends nothing new.
      await pressEnter(page);
      await page.waitForTimeout(1000);
      expect(engine.utterances()).toHaveLength(1);
      expect(errors.filter((e) => /unhandled|Uncommitted/i.test(e))).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  // The kept record belongs to the chat it was pressed in. The same words
  // in another chat send normally; chat A's late ack clears only chat A's box;
  // the kept words and the notice come back when chat A is reopened.
  // (Sends to one engine go one at a time, in order: B's frame follows A's
  // ack; B's send itself, its bubble and cid, is there at the press.)
  test(`R6 kept send is the chat's own: the same words send in another chat, a late ack clears only its own box, reopening brings the kept state back (${layout})`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const engine = await chatRig(true);
    const log = captureLog(page);
    const errors = watchErrors(page);
    const framesOf = (paneId: string) => engine.utterances.filter((u) => u.paneId === paneId);
    try {
      await bootChat(page, engine, size);
      const sidA = sidOf(engine.port, A);
      const sidB = sidOf(engine.port, B);
      await page.evaluate(() => {
        (window as unknown as {__cycAckTimeoutMs?: number}).__cycAckTimeoutMs = 1500;
      });
      engine.holdAcksAfter(0);
      await breakIntentsStore(page);
      await typeAndSend(page, 'same words');
      await expect.poll(() => log.of('send.kept').length, {timeout: 10_000}).toBe(1);
      await expect.poll(() => keptToasts(page)).toBe(1);
      const cidA = (await sendOf(page, sidA, 'same words'))?.cid;
      expect(cidA).toBeTruthy();
      // The same words in chat B are a new message: B's own bubble and cid at
      // the press, no kept-press.
      await switchChat(page, layout, NAME_B);
      expect(await boxText(page)).toBe('');
      await typeAndSend(page, 'same words');
      await expect.poll(() => sendOf(page, sidB, 'same words').then((m) => m?.cid), {
        timeout: 5_000
      }).toBeTruthy();
      const cidB = (await sendOf(page, sidB, 'same words'))?.cid;
      expect(cidB).not.toBe(cidA);
      expect(log.of('send.kept-press')).toHaveLength(0);
      expect(log.of('send.uncommitted')).toHaveLength(2);
      await expect.poll(() => log.of('send.kept').length, {timeout: 10_000}).toBe(2);
      // Chat A's ack lands while chat B is open: A's draft is dropped, B's
      // box keeps B's words; B's frame goes now, its ack held in turn.
      engine.releaseAcks(A);
      await expect.poll(() => statusOf(page, sidA, 'same words'), {timeout: 10_000}).toBe(
        'delivered'
      );
      await expect.poll(() => log.of('send.taken-late').length, {timeout: 10_000}).toBe(1);
      await expect.poll(() => framesOf(B).length, {timeout: 10_000}).toBe(1);
      expect(distinctCids(engine.utterances)).toBe(2);
      await page.waitForTimeout(500);
      expect(await boxText(page)).toBe('same words');
      expect(log.of('send.kept-taken').filter((l) => l.field('cleared') === 'true')).toHaveLength(
        0
      );
      // Chat A reopened: taken, so an empty box and no notice.
      await switchChat(page, layout, NAME);
      await expect.poll(() => boxText(page)).toBe('');
      expect(await keptToasts(page)).toBe(0);
      // Chat B reopened: the kept words and the notice are back, and Enter
      // still sends nothing new.
      await switchChat(page, layout, NAME_B);
      await expect.poll(() => boxText(page)).toBe('same words');
      await expect.poll(() => keptToasts(page)).toBe(1);
      await pressEnter(page);
      await page.waitForTimeout(500);
      expect(log.of('send.kept-press')).toHaveLength(1);
      expect(distinctCids(engine.utterances)).toBe(2);
      // B's own ack clears B's box.
      engine.releaseAcks(B);
      await expect.poll(() => statusOf(page, sidB, 'same words'), {timeout: 10_000}).toBe(
        'delivered'
      );
      await expect.poll(() => boxText(page), {timeout: 10_000}).toBe('');
      await expect.poll(() => keptToasts(page)).toBe(0);
      expect(log.of('send.taken-late')).toHaveLength(2);
      expect(engine.delivered.size).toBe(2);
      expect(distinctCids(engine.utterances)).toBe(2);
      expect(errors.filter((e) => /unhandled|Uncommitted/i.test(e))).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  // An unsaved send waiting on the engine must not gate the composer. A
  // press in another chat during the wait is taken at once: its bubble, its
  // cid, its own send. (Its frame follows A's ack: one send at a time per
  // engine, in order.)
  test(`R6 unsaved send waiting on a slow ack does not block a press in another chat (${layout})`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const engine = await chatRig(true);
    const log = captureLog(page);
    const errors = watchErrors(page);
    const framesOf = (paneId: string) => engine.utterances.filter((u) => u.paneId === paneId);
    try {
      await bootChat(page, engine, size);
      const sidA = sidOf(engine.port, A);
      const sidB = sidOf(engine.port, B);
      await page.evaluate(() => {
        (window as unknown as {__cycAckTimeoutMs?: number}).__cycAckTimeoutMs = 8000;
      });
      engine.holdAcksAfter(0);
      await breakIntentsStore(page);
      await typeAndSend(page, 'slow one');
      await expect.poll(() => log.of('send.uncommitted').length, {timeout: 10_000}).toBe(1);
      await switchChat(page, layout, NAME_B);
      await typeAndSend(page, 'quick one');
      // B's send exists well inside A's 8 s deadline: painted, with its cid,
      // its write tried (and failed) like A's.
      await expect.poll(() => sendOf(page, sidB, 'quick one').then((m) => m?.cid), {
        timeout: 3_000
      }).toBeTruthy();
      expect(log.of('send.uncommitted')).toHaveLength(2);
      expect(log.of('send.kept-press')).toHaveLength(0);
      expect(framesOf(A)).toHaveLength(1);
      // Both taken within their deadlines: no notice, B's box clears, B's
      // frame goes behind A's ack.
      engine.releaseAcks();
      await expect.poll(() => framesOf(B).length, {timeout: 10_000}).toBe(1);
      await expect.poll(() => statusOf(page, sidA, 'slow one'), {timeout: 10_000}).toBe(
        'delivered'
      );
      await expect.poll(() => statusOf(page, sidB, 'quick one'), {timeout: 10_000}).toBe(
        'delivered'
      );
      await expect.poll(() => boxText(page), {timeout: 10_000}).toBe('');
      await expect.poll(() => log.of('send.taken-unsaved').length, {timeout: 10_000}).toBe(2);
      expect(await keptToasts(page)).toBe(0);
      expect(engine.delivered.size).toBe(2);
      expect(distinctCids(engine.utterances)).toBe(2);
      expect(errors.filter((e) => /unhandled|Uncommitted/i.test(e))).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  // The engine refuses the unsaved send. The words stay with the notice
  // and Enter makes no second cid; the retry tap sends the same cid again, and
  // when that lands the box and the notice go.
  test(`R6 refused unsaved send: Enter resends nothing, the retry tap lands the same cid and clears the box (${layout})`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const engine = await chatRig();
    const log = captureLog(page);
    const errors = watchErrors(page);
    try {
      await bootChat(page, engine, size);
      const sid = sidOf(engine.port, A);
      await breakIntentsStore(page);
      engine.nackNext();
      await typeAndSend(page, 'nack kept');
      await expect.poll(() => statusOf(page, sid, 'nack kept'), {timeout: 10_000}).toBe('failed');
      await expect.poll(() => log.of('send.kept').length, {timeout: 10_000}).toBe(1);
      expect(await boxText(page)).toBe('nack kept');
      await expect.poll(() => keptToasts(page)).toBe(1);
      // Enter while refused: the kept-press guard holds.
      await pressEnter(page);
      await page.waitForTimeout(500);
      expect(log.of('send.kept-press')).toHaveLength(1);
      expect(distinctCids(engine.utterances)).toBe(1);
      // The retry tap: same cid, taken this time.
      const note = page.locator('#cyc-thread-pane .cyc-message').last().locator('.cyc-send-failed');
      await expect(note).toHaveCount(1);
      await note.click();
      await expect.poll(() => statusOf(page, sid, 'nack kept'), {timeout: 15_000}).toBe(
        'delivered'
      );
      await expect.poll(() => boxText(page), {timeout: 10_000}).toBe('');
      await expect.poll(() => keptToasts(page)).toBe(0);
      expect(log.of('send.taken-late')).toHaveLength(1);
      expect(log.of('send.kept-taken').filter((l) => l.field('cleared') === 'true')).toHaveLength(
        1
      );
      expect(distinctCids(engine.utterances)).toBe(1);
      expect(engine.delivered.size).toBe(1);
      // The box is free: Enter sends nothing, one copy delivered.
      await pressEnter(page);
      await page.waitForTimeout(1000);
      expect(distinctCids(engine.utterances)).toBe(1);
      expect(engine.delivered.size).toBe(1);
      expect(
        (await heldMessages(page, sid)).filter((m) => m.role === 'user' && m.text === 'nack kept')
      ).toHaveLength(1);
      expect(errors.filter((e) => /unhandled|Uncommitted/i.test(e))).toEqual([]);
    } finally {
      await engine.close();
    }
  });
}
