import {test, expect} from '@playwright/test';
import {bootPinned, evidenceShot} from './rig';
import {startChatEngine, type ChatEngine, type ChatMsg} from './chatEngine';
import {domMessageCount, heldMessages, openChat, sidOf, waitLive} from './offlineKit';

// The duplicate-chat-rows bug (reported 2026-09-02 ~21:16): after a hard
// restart every chat row was painted TWICE, both roles, each a verbatim twin
// with the same ts. The cause: the engine renumbers a message's seq onto a
// shifted axis when a session record is inserted across a restart (the live
// log carries rows with colliding seqs), and the app keyed its row dedup on
// seq -- so a row re-served under a changed seq missed the seen set and painted
// a second bubble beside the one already held.
//
// This spec reproduces it end to end on the offline rig: warm a chat so its
// rows paint once, then renumber the seqs (rig.renumberOnResume, ts untouched)
// and reconnect. The rows must still be painted ONCE. Two cases: a LEGACY log
// with no durable id (dedup falls back to the stable ts|role|text) and a log
// whose rows carry the engine's durable `mid` (dedup keys on it). Both painted
// twice before the fix.

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const SESSION = 'duprows';
const NAME = 'Dup Rows';
const BASE = 1_700_000_000_000;

// A short, mixed-role conversation so a twin of EITHER role is visible and
// every row keeps a unique ts. `withMid` decides whether the rows carry the
// engine's durable id (a current log) or not (a legacy log).
function seed(withMid: boolean): ChatMsg[] {
  const lines: [ChatMsg['role'], string][] = [
    ['user', 'first question'],
    ['claude', 'first answer'],
    ['user', 'second question'],
    ['claude', 'second answer'],
    ['user', 'third question'],
    ['claude', 'third answer']
  ];
  return lines.map(([role, text], i) => ({
    seq: i,
    role,
    text,
    ts: BASE + i * 1000,
    msgId: `${SESSION}-m${i}`,
    ...(withMid ? {mid: `mr-durable${String(i).padStart(8, '0')}`} : {})
  }));
}

function rig(withMid: boolean): Promise<ChatEngine> {
  return startChatEngine({
    trackHeard: false,
    sessions: [{id: SESSION, name: NAME, messages: seed(withMid)}]
  });
}

for (const withMid of [false, true]) {
  const label = withMid ? 'durable mid' : 'legacy ts|role|text';
  test(`a seq renumber across a reconnect paints each row once (${label})`, async ({page}) => {
    test.setTimeout(120_000);
    const engine = await rig(withMid);
    const sid = sidOf(engine.port, SESSION);
    const ROWS = seed(withMid).length;
    try {
      // --- WARM: rows paint exactly once ---
      await bootPinned(page, engine.port, {size: {width: 1280, height: 900}});
      await openChat(page, NAME);
      await expect
        .poll(() => heldMessages(page, sid).then((m) => m.length), {
          timeout: 20_000,
          message: 'the warm chat never hydrated'
        })
        .toBe(ROWS);
      await expect.poll(() => domMessageCount(page), {timeout: 15_000}).toBe(ROWS);

      // --- HARD RESTART: the engine dies, and while it is down it renumbers the
      //     seqs (a session record inserted onto the shared axis) ---
      await engine.stop();
      engine.renumberOnResume(SESSION);

      // Reload OFFLINE: the cache paints the rows from IndexedDB with their OLD
      // seqs (the engine is down, so nothing rewrites the cache first).
      await page.reload();
      await openChat(page, NAME);
      await expect
        .poll(() => heldMessages(page, sid).then((m) => m.length), {
          timeout: 20_000,
          message: 'the cached rows did not repaint offline'
        })
        .toBe(ROWS);

      // The engine returns and BACKFILLS the same rows with their NEW seqs -- the
      // exact reconnect backfill from the report. Keying dedup on seq admitted
      // the engine copy beside the cached one, a twin of every row.
      await engine.start();
      await waitLive(page);

      // --- each row must still be painted ONCE, not twinned ---
      await expect
        .poll(() => heldMessages(page, sid).then((m) => m.length), {
          timeout: 20_000,
          message: `the renumbered rows were admitted as twins (want ${ROWS} held)`
        })
        .toBe(ROWS);
      await expect
        .poll(() => domMessageCount(page), {
          timeout: 15_000,
          message: `the renumbered rows painted twin bubbles (want ${ROWS})`
        })
        .toBe(ROWS);

      // The held rows adopted the engine's new seqs (paging axis stays current).
      const seqs = (await heldMessages(page, sid)).map((m) => m.seq).sort((a, b) => a! - b!);
      expect(seqs[0]).toBeGreaterThan(ROWS - 1);
      await evidenceShot(page, 'dup-rows', withMid ? 'mid' : 'legacy');
    } finally {
      await engine.close();
    }
  });
}
