/* Shared given/when steps. A scenario file reads as given/when/then; the
 * mechanics of "a pane running the harness, bound to the engine" live here
 * once, so a red verdict in a scenario is about the engine, not the bench. */

import type { Cell } from "../cell/driver.ts";
import type { Pane } from "../cell/mux.ts";
import type { SessionRow } from "../cell/wire.ts";
import type { Transcript } from "../cell/harness.ts";

export const SPEC = {
  /** design 1: announce grace before a guess; a row must exist by then */
  bringUpMs: 10_000,
  /** design 5: a `landed` verdict must come within 8 s of typing */
  landedMs: 8_000,
  /** engine list-panes poll is 2 s; "within one poll" with slack */
  pollMs: 4_000,
};

/** the harness session id as the wire names it: spec `harnessSessionId`, today `claudeSessionId` */
export const sidOf = (r: SessionRow | null | undefined): string => String(r?.harnessSessionId ?? r?.claudeSessionId ?? "");
export const stableIdOf = (r: SessionRow | null | undefined): string => String(r?.sessionAgentId ?? "");

export type BringUp = { pane: Pane; row: SessionRow | null; transcript: Transcript | null; firstPrompt: string };

/** given: a pane running the harness with the integration installed, the
 *  engine up, one prompt typed (the UserPromptSubmit announce), a transcript. */
export async function bringUp(c: Cell, opts: { engineFirst?: boolean; prompt?: string; cwd?: string; resume?: string; extra?: string; noPrompt?: boolean } = {}): Promise<BringUp> {
  const cwd = opts.cwd ?? c.paths.work;
  if (opts.engineFirst !== false) await c.startEngine();
  const pane = await c.openPane({ cwd });
  await c.launch(pane, { resume: opts.resume, extra: opts.extra });
  await c.snap("launched", pane.id);
  const firstPrompt = opts.prompt ?? `hello ${c.scenario}`;
  if (!opts.noPrompt) {
    await c.type(pane, firstPrompt);
    const t = await c.waitFor(async () => (await c.transcript(cwd)).find((x) => x.userTexts.some((u) => u.includes(firstPrompt))) ?? null, { ms: 30_000, label: "first prompt in transcript" });
    c.need("the first prompt reached the harness transcript", !!t, t ? t.path : `no transcript under ${cwd} holds ${JSON.stringify(firstPrompt)}; screen: ${(await c.snap("no-transcript", pane.id)).slice(-800)}`);
    /* the fake model saw it: the harness is wired to the bench, not to the world */
    const r = await c.fake().waitRequest((q) => q.userTexts.some((u) => u.includes(firstPrompt)), 20_000);
    c.need("the fake model served the first prompt", !!r);
  }
  if (opts.engineFirst === false) await c.startEngine();
  const transcript = opts.noPrompt ? null : (await c.transcript(cwd)).find((x) => x.userTexts.some((u) => u.includes(firstPrompt))) ?? null;
  const w = await c.wire();
  const row = await w.waitRow((r) => r.cwd === cwd && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "a live row for the pane" });
  await c.snap("bound", pane.id);
  return { pane, row, transcript, firstPrompt };
}

/** when: the person sends a message from the app; returns evidence handles.
 *  `attach: false` utters straight away on a fresh wire (the engine takes an
 *  utterance without an attach); the attach follows so chat rows still flow. */
export async function sendFromApp(c: Cell, row: SessionRow, text: string, opts: { attach?: boolean } = {}) {
  const w = await c.wire();
  const before = (await c.transcript(row.cwd ?? c.paths.work)).map((t) => t.userTexts.length).reduce((a, b) => a + b, 0);
  const seq = w.frames.length;
  const at = Date.now();
  if (opts.attach !== false) await w.attach(row.id);
  const cid = `tb-${at}-${seq}`;
  w.utter(row.id, text, cid);
  c.log(`utter -> ${row.id} cid=${cid}: ${JSON.stringify(text)}`);
  if (opts.attach === false) await w.attach(row.id).catch(() => null);
  return {
    at, seq, before, cid,
    /** the chat row(s) for our text, as the app sees them */
    chatRows: () => w.chatRows(row.id, seq).filter((f) => f.text === text || String(f.text ?? "").includes(text)),
    /** the transcript grew by a user turn holding our text */
    landedInTranscript: async () => (await c.transcript(row.cwd ?? c.paths.work)).find((t) => t.userTexts.some((u) => u.includes(text))) ?? null,
    /** the fake model served a turn holding our text */
    served: () => c.fake().requestsWith(text),
    /** the same, waited for: a transcript landing can precede the model
     *  request (opencode writes the user row at submit), so "the fake saw
     *  it" is a bounded wait, never a single read */
    servedWithin: (ms = 20_000) => waitServed(c, text, ms),
  };
}

/** wait (bounded) until the fake model holds a request carrying the text */
export async function waitServed(c: Cell, text: string, ms = 20_000) {
  return (await c.waitFor(() => { const q = c.fake().requestsWith(text); return q.length ? q : null; }, { ms, label: `fake model served ${JSON.stringify(text.slice(0, 30))}` })) ?? [];
}

export async function waitLanded(c: Cell, s: Awaited<ReturnType<typeof sendFromApp>>, ms = 30_000) {
  const t = await c.waitFor(() => s.landedInTranscript(), { ms, label: "message in transcript" });
  const state = await c.waitFor(() => { const r = s.chatRows().find((f) => f.state === "landed" || f.queued === false || f.delivered); return r ?? null; }, { ms: 2000 });
  return { transcript: t, chat: state, rows: s.chatRows() };
}

export function paneEnvId(c: Cell, pane: Pane): string { return pane.id; }

/** the agents dir as evidence: metas with harness-shaped session ids */
export function mintedAgents(c: Cell) {
  return c.agents().filter((a) => a.meta && !a.meta.mergedInto);
}

export const uniq = <T,>(xs: T[]) => Array.from(new Set(xs));

/** the id `<harness> --resume` takes: the wire's, else the transcript's own */
export const resumeIdOf = (row: SessionRow | null | undefined, transcript: Transcript | null | undefined): string =>
  sidOf(row) || transcript?.id || "";

/** the newest transcript under a cwd, by mtime */
export async function latestTranscript(c: Cell, cwd = c.paths.work): Promise<Transcript | null> {
  const ts = await c.transcript(cwd);
  return ts.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

/** wait until the cwd has no live row: one marked alive:false (the spec) or
 *  none listed at all (a row that vanished); says which */
export async function waitOffline(c: Cell, cwd: string, ms: number): Promise<{ row: SessionRow | null; vanished: boolean; at: number } | null> {
  const w = await c.wire();
  const f = await w.waitFrame((x) => x.t === "sessions" && !(x.list ?? []).some((r: SessionRow) => r.cwd === cwd && r.alive !== false), { ms, label: "no live row for the cwd" });
  if (!f) return null;
  const row = (f.list as SessionRow[]).find((r) => r.cwd === cwd) ?? null;
  return { row, vanished: !row, at: f._ts };
}

/** rows on the wire for a cwd, live first */
export const rowsFor = (rows: SessionRow[], cwd: string) => rows.filter((r) => r.cwd === cwd).sort((a, b) => Number(!!b.alive) - Number(!!a.alive));

/** how many user turns across a cwd's transcripts hold a text */
export async function userTurnsWith(c: Cell, text: string, cwd = c.paths.work): Promise<number> {
  return (await c.transcript(cwd)).reduce((n, t) => n + t.userTexts.filter((u) => u.includes(text)).length, 0);
}
