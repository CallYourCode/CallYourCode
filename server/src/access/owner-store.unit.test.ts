/* owner-store.ts as a unit: the validators, the settings round-trip, the
 * badge arithmetic, the tracked-chats guard, and the outgoing window's flush.
 * No timers run: flushOut is called directly and msToBoundary is checked with
 * an injected clock. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerStore, cleanStrings, sidList, chordMap, msToBoundary,
  SETTINGS_DEFAULTS } from "./owner-store";
import { TRACKED_CHATS_MAX, BATCH_MS } from "../platform/caps";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
const scratch = async () => {
  const d = await mkdtemp(join(tmpdir(), "cyc-ostore-unit-"));
  dirs.push(d);
  return d;
};
const silent = () => {};

async function open(d: string, log: (e: string, f: Record<string, unknown>) => void = silent) {
  return OwnerStore.open(join(d, "push.json"), join(d, "settings.json"),
    join(d, "reports"), log);
}

/* ------------------------------------------------------------- validators */

test("chordMap: all-strings or refused whole; {} and null stay distinct", () => {
  expect(chordMap({ a: "ctrl+k", b: "" })).toEqual({ a: "ctrl+k", b: "" });
  expect(chordMap({})).toEqual({});
  expect(chordMap({ a: 1 })).toBeNull();
  expect(chordMap(["a"])).toBeNull();
  expect(chordMap(null)).toBeNull();
});

test("sidList: bounded all-string list or refused whole; [] is a real answer", () => {
  expect(sidList(["s1", "s2"])).toEqual(["s1", "s2"]);
  expect(sidList([])).toEqual([]);
  expect(sidList(["ok", 3])).toBeNull();
  expect(sidList([""])).toBeNull();
  expect(sidList(["x".repeat(301)])).toBeNull();
  expect(sidList(Array.from({ length: 501 }, () => "s"))).toBeNull();
  expect(sidList("s1")).toBeNull();
});

test("cleanStrings: plain bounded object stored verbatim, else null", () => {
  const bag = { v1: { name: "Terse" }, order: ["a", "b"] };
  expect(cleanStrings(bag)).toBe(bag);   // verbatim, never rebuilt
  expect(cleanStrings([])).toBeNull();
  expect(cleanStrings("x")).toBeNull();
  expect(cleanStrings({ big: "x".repeat(41_000) })).toBeNull();
});

/* --------------------------------------------------------- settings file */

test("open(): defaults on a fresh dir, saved values on the next open", async () => {
  const d = await scratch();
  const a = await open(d);
  expect(a.settings).toEqual(SETTINGS_DEFAULTS);
  a.settings.speed = 2;
  a.settings.replyLevel = 5;
  a.settings.keymap = { send: "ctrl+enter" };
  a.settings.dismissed = ["h:1"];
  await a.saveSettings();
  const b = await open(d);
  expect(b.settings.speed).toBe(2);
  expect(b.settings.replyLevel).toBe(5);
  expect(b.settings.keymap).toEqual({ send: "ctrl+enter" });
  expect(b.settings.dismissed).toEqual(["h:1"]);
  // the untouched keys still stand at their defaults
  expect(b.settings.complexityOn).toBe(false);
  expect(b.settings.verbosityOn).toBe(true);
});

test("open() drops junk fields instead of storing them", async () => {
  const d = await scratch();
  const a = await open(d);
  (a.settings as any).speed = 99;          // out of range once written by hand
  (a.settings as any).replyLevel = "five";
  await a.saveSettings();
  const b = await open(d);
  expect(b.settings.speed).toBe(SETTINGS_DEFAULTS.speed);
  expect(b.settings.replyLevel).toBeUndefined();
});

/* ------------------------------------------------------- badge + tracking */

test("badge() is the SUM of pending counts, not the map size", async () => {
  const d = await scratch();
  const s = await open(d);
  s.pending.set("a", 3);
  s.pending.set("b", 2);
  expect(s.badge()).toBe(5);
  s.pending.delete("a");
  expect(s.badge()).toBe(2);
});

test("room(): updates always allowed, new keys refused at the cap, said once in the log", async () => {
  const d = await scratch();
  const events: string[] = [];
  const s = await open(d, (e) => { events.push(e); });
  for (let i = 0; i < TRACKED_CHATS_MAX; i++) s.pending.set(`s${i}`, 1);
  expect(s.room(s.pending, "s0", "pending")).toBe(true);       // already tracked
  expect(s.room(s.pending, "fresh", "pending")).toBe(false);   // the cap bites
  expect(events).toContain("push.tracking.full");
});

/* --------------------------------------------------------- the out window */

test("msToBoundary: next boundary plus the lag offset, from an injected now", () => {
  expect(msToBoundary(BATCH_MS, 2_000, 20_000)).toBe(2_000);   // :20 -> :22
  expect(msToBoundary(BATCH_MS, 2_000, 21_999)).toBe(1);       // just before :22
  expect(msToBoundary(BATCH_MS, 2_000, 22_000)).toBe(10_000);  // on it: next window
  expect(msToBoundary(BATCH_MS, 0, 15_000)).toBe(5_000);
});

test("flushOut: one payload carrying every session and dismissal, then empty maps", async () => {
  const d = await scratch();
  const s = await open(d);
  const sent: any[] = [];
  (s.push as any).send = async (p: any) => { sent.push(p); };
  s.pending.set("s1", 2);
  s.outNew.set("s1", { sessionId: "s1", title: "T1", body: "B1", count: 2, kid: "k", enc: "e" });
  s.outDismiss.add("s2");
  await s.flushOut();
  expect(sent.length).toBe(1);
  expect(sent[0].t).toBe("batch");
  // legacy-worker fields ride the first session so an old worker still shows a banner
  expect(sent[0].title).toBe("T1");
  expect(sent[0].sessionId).toBe("s1");
  expect(sent[0].sessions).toEqual([
    { sessionId: "s1", title: "T1", body: "B1", count: 2, kid: "k", enc: "e" },
  ]);
  expect(sent[0].dismissed).toEqual(["s2"]);
  expect(sent[0].badge).toBe(2);
  expect(s.outNew.size).toBe(0);
  expect(s.outDismiss.size).toBe(0);
});

test("flushOut with nothing waiting sends nothing", async () => {
  const d = await scratch();
  const s = await open(d);
  const sent: any[] = [];
  (s.push as any).send = async (p: any) => { sent.push(p); };
  await s.flushOut();
  expect(sent.length).toBe(0);
});

test("a dismissal-only flush still names a tag and the fallback wording", async () => {
  const d = await scratch();
  const s = await open(d);
  const sent: any[] = [];
  (s.push as any).send = async (p: any) => { sent.push(p); };
  s.outDismiss.add("s9");
  await s.flushOut();
  expect(sent[0].sessionId).toBe("s9");
  expect(sent[0].tag).toBe("s9");
  expect(sent[0].body).toBe("Messages read on another device");
});
