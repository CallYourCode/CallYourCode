import { afterEach, expect, test } from "bun:test";
import { claimLaunch, waitForLaunch } from "./launch-claims.ts";
import { sessions, type Session } from "./session-state.ts";
import { hookAnnouncedAfter, hookAnnouncementVersion, recordHookBind, resetHookAnnounce } from "../terminal/hook-announce.ts";
const aid = "ag-0123456789abcdef", sid = "11111111-1111-4111-8111-111111111111", pane = "w99:p99";
afterEach(() => { sessions.delete(aid); resetHookAnnounce(); });
test("app reopen and recovery reserve both identities until detection", () => {
  const release = claimLaunch(aid, sid)!;
  expect(release).not.toBeNull();
  expect(claimLaunch(aid, null)).toBeNull();
  expect(claimLaunch("ag-abcdef0123456789", sid)).toBeNull();
  release();
  const again = claimLaunch(aid, sid);
  expect(again).not.toBeNull();
  again?.();
});
test("stored session metadata and a stale bind are not a new launch announcement", async () => {
  recordHookBind(pane, sid, 0);
  const since = hookAnnouncementVersion();
  sessions.set(aid, { alive: true, muxHandle: pane, harnessSessionId: sid } as Session);
  expect(hookAnnouncedAfter(pane, sid, since)).toBe(false);
  await expect(waitForLaunch(aid, sid, pane, 1, since)).rejects.toThrow("not detected");
  recordHookBind(pane, sid, 1); // a same-id re-announce is still live evidence
  expect(hookAnnouncedAfter(pane, sid, since)).toBe(true);
  await waitForLaunch(aid, sid, pane, 1, since);
});

test("persisted binds are not live announcements, regardless of their wall-clock timestamp", () => {
  recordHookBind(pane, sid, 0);
  resetHookAnnounce(); // force the next read to load the persisted file
  expect(hookAnnouncedAfter(pane, sid, 0)).toBe(false);
  recordHookBind(pane, sid, 1);
  expect(hookAnnouncedAfter(pane, sid, 0)).toBe(true);
});
