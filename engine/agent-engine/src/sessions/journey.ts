/* One message's journey, across the browser, the app server and the engine.
 *
 * WHY THIS EXISTS
 *
 * Task 166 put logging everywhere and cyclog.sh merges it, but merging is not
 * answering. Three investigations in one day were settled by a person grepping
 * .run/frontend.log and .run/engine.log and lining timestamps up by eye -- the
 * send-latency question, the "session log unavailable" pill, and the new-session
 * route that had never once worked. Each took tens of minutes, and each was the
 * same work: take one id, find the ids it turns into, and put the hops in order.
 *
 *   scripts/journey.sh c-msgg5mok-5ulxu      one recording, end to end
 *   scripts/journey.sh 1e4f55bd-2024-45c7-a4c5-c1bb6732c698
 *   scripts/journey.sh --session w9:p4 --at 18:55
 *
 * WHY IT IS NOT A GREP
 *
 * The id changes at every boundary, and no line carries all three:
 *
 *   c-msgg5mok-5ulxu   the CAPTURE, minted in the browser when the mic opens
 *   6062a643-…         the UPLOAD, minted by the engine when it takes the bytes
 *   1e4f55bd-…         the WIRE cid, minted per utterance frame at send
 *
 * A grep for any one of them finds a third of the story. The joins between them
 * are in the log too -- `upload.done cid=… msgId=…` welds the first two,
 * `utterance.in cid=… upload=…` welds the last two -- so this walks them.
 *
 * WHAT IT REFUSES TO DO
 *
 * It never skips a hop it cannot find. A hop with no line prints as missing,
 * and says which of the three reasons it is: nothing in the code records it,
 * the log that would record it is not on this machine, or the log covers that
 * minute and the line is genuinely absent. Silently printing only what was
 * found is how "it seemed to send and then it was not there" stayed
 * unanswerable, and it is the same defect class as an app that states what it
 * does not know.
 *
 * READ-ONLY. It opens files under .run and writes nothing anywhere.
 */

import { readFileSync, existsSync } from "node:fs";

/* ------------------------------------------------------------------ parsing */

export type Ev = {
  ts: number;            // ms since epoch, by the clock of whoever wrote it
  iso: string;
  service: string;       // app | app-server | engine
  event: string;
  f: Record<string, string>;
  file: string;          // display path
  line: number;          // 1-based line number in that file
  text: string;          // the whole line, for --raw and for dedup
};

/* A line with no timestamp of its own: the engine's [notify], [utterance],
 * [deliver], [new-session] prints, which go through console.log and never
 * through the logbook. They cannot be sorted into the stream, so each is
 * pinned to the last timestamped line ABOVE it in its own file and is only
 * ever shown as "after" that time. Every outcome of /new-session is one of
 * these, which is why they are read at all. */
export type Note = {
  after: number;         // ts of the preceding timestamped line, or 0
  service: string;
  text: string;
  file: string;
  line: number;
};

const TS_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (\S+) (\S+)(?: (.*))?$/;
const KV_RE = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;

export function parseFields(rest: string): Record<string, string> {
  const f: Record<string, string> = {};
  if (!rest) return f;
  for (const m of rest.matchAll(KV_RE)) {
    let v = m[2];
    if (v.startsWith('"')) { try { v = JSON.parse(v) as string; } catch { /* leave raw */ } }
    if (!(m[1] in f)) f[m[1]] = v;   // first wins: `why="…"` can repeat a word
  }
  return f;
}

export function parseLine(text: string, file: string, line: number): Ev | null {
  const m = TS_RE.exec(text);
  if (!m) return null;
  const ts = Date.parse(m[1]);
  if (!Number.isFinite(ts)) return null;
  return { ts, iso: m[1], service: m[2], event: m[3], f: parseFields(m[4] ?? ""), file, line, text };
}

export type Sources = { events: Ev[]; notes: Note[]; files: { path: string; lines: number; used: number }[] };

/* Every log this machine has, most complete first.
 *
 * BOTH the stdout logs and the .run/logs mirror, and that is not belt and
 * braces. The mirror's path is resolved relative to the module that writes it,
 * so an engine started from a worktree or a deploy directory mirrors into ITS
 * OWN .run/logs while its stdout still lands in the one start-v1.sh opened.
 * Measured on 2026-08-05: the live engine's user-audio.stored lines for that
 * morning are in .run/engine.log and are NOT in .run/logs/engine.log. Reading
 * only the tidy one would have reported the engine as silent when it was not.
 *
 * The mirror earns its place the other way round: the stdout files are
 * truncated on every restart, and the mirror keeps one rotated generation, so
 * it reaches back past today.
 *
 * Duplicates are exact -- the logbook console.logs the same string it queues --
 * so dedup is on the whole line. */
export function loadSources(root: string): Sources {
  const candidates = [
    `${root}/.run/engine.log`,          // engine stdout: superset, plus the bracket lines
    `${root}/.run/frontend.log`,        // app server stdout: the browser's lines and its own
    `${root}/.run/logs/engine.log`,
    `${root}/.run/logs/engine.log.1`,
    `${root}/.run/logs/app.log`,
    `${root}/.run/logs/app.log.1`,
    `${root}/.run/logs/app-server.log`,
    `${root}/.run/logs/app-server.log.1`,
    /* The engine's logbook mirror lives in the DATA DIR now (~/.callyourcode/
     * logs, the design), so --root may also point at one of those. The .run
     * candidates above stay: the start scripts' stdout files and any older
     * checkout's mirror are still worth reading. */
    `${root}/logs/engine.log`,
    `${root}/logs/engine.log.1`,
    `${root}/logs/app.log`,
    `${root}/logs/app.log.1`,
    `${root}/logs/app-server.log`,
    `${root}/logs/app-server.log.1`,
  ];
  const events: Ev[] = [];
  const notes: Note[] = [];
  const files: Sources["files"] = [];
  const seen = new Set<string>();

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    const short = path.slice(root.length + 1);
    let used = 0;
    let lastTs = 0;
    let lastService = short.includes("frontend") ? "app-server" : "engine";
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (!text) continue;
      const ev = parseLine(text, short, i + 1);
      if (ev) {
        lastTs = ev.ts;
        lastService = ev.service;
        if (seen.has(text)) continue;
        seen.add(text);
        events.push(ev);
        used++;
        continue;
      }
      // untimestamped: keep only the engine's bracket prints, pinned in place
      if (text.startsWith("[")) {
        notes.push({ after: lastTs, service: lastService, text, file: short, line: i + 1 });
      }
    }
    files.push({ path: short, lines: lines.length, used });
  }
  events.sort((a, b) => a.ts - b.ts || a.file.localeCompare(b.file) || a.line - b.line);
  return { events, notes, files };
}

/* ------------------------------------------------------------------- joining */

/** Which fields hold an id, and which id space each belongs to. */
const CID_FIELDS = ["cid", "key"];
const UPLOAD_FIELDS = ["msgId", "upload", "uploads", "asked", "filled"];

const isCapture = (id: string) => id.startsWith("c-");
const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

export type Join = { how: string; exact: boolean; evidence: string };
export type Identity = {
  cids: Set<string>;         // capture cids and wire cids: both live in cid=
  uploads: Set<string>;      // engine-minted upload/msgIds
  sessions: Set<string>;
  devs: Set<string>;
  pages: Set<string>;
  engines: Set<string>;
  joins: Join[];
};

/** A uuid is unreadable at full length and unique in eight; a capture id is
 *  short and is read out loud, so it is left alone. */
const short = (id: string) => (/^[0-9a-f]{8}-[0-9a-f-]+$/i.test(id) ? id.slice(0, 8) : id);

/* Grow the id set until it stops growing.
 *
 * Every rule here was read off real lines in .run/logs, not off the code that
 * writes them: the code says what it intends to log and the file says what it
 * logged, and where they disagreed (the block-upload path logs nothing at all)
 * the file won. */
export function resolve(events: Ev[], seedIds: string[], opts: { adjacencyMs?: number } = {}): Identity {
  const ADJ = opts.adjacencyMs ?? 3000;
  const id: Identity = {
    cids: new Set(), uploads: new Set(), sessions: new Set(),
    devs: new Set(), pages: new Set(), engines: new Set(), joins: [],
  };
  for (const s of seedIds) (isCapture(s) ? id.cids : /^[0-9a-f-]{20,}$/i.test(s) ? id.uploads : id.cids).add(s);
  // a seed uuid may be either a wire cid or an upload id; try it as both
  for (const s of seedIds) if (!isCapture(s)) id.cids.add(s);

  const idsOf = (e: Ev) => {
    const cids: string[] = [], ups: string[] = [];
    for (const k of CID_FIELDS) if (e.f[k]) cids.push(...split(e.f[k]));
    for (const k of UPLOAD_FIELDS) if (e.f[k]) ups.push(...split(e.f[k]));
    return { cids, ups };
  };

  /* Every id that some ONE LINE says belongs with an id we already have, until
   * nothing new comes out. Only lines are consulted here, never timing: this
   * pass can be wrong only if the log itself is wrong. */
  const exactPass = () => {
    let grew = false;
    for (const e of events) {
      const { cids, ups } = idsOf(e);
      // the id we already knew, read off BEFORE anything new is added, so the
      // reason printed names what this line was joined TO
      const anchor = cids.find((c) => id.cids.has(c)) ?? ups.find((u) => id.uploads.has(u));
      if (!anchor) continue;
      for (const c of cids) if (!id.cids.has(c)) {
        id.cids.add(c); grew = true;
        id.joins.push({
          how: `${short(c)} is the same message as ${short(anchor)}`,
          exact: true,
          evidence: `${e.service} ${e.event} carries both (${e.file}:${e.line})`,
        });
      }
      for (const u of ups) if (!id.uploads.has(u)) {
        id.uploads.add(u); grew = true;
        id.joins.push({
          how: `upload ${short(u)} belongs to ${short(anchor)}`,
          exact: true,
          evidence: `${e.service} ${e.event} carries both (${e.file}:${e.line})`,
        });
      }
      /* `session=` is two different things in this log: a real session id
       * (w9:p4), the socket URL and the id (wss://host/ws|w9:p4), or the word
       * "(press)" when a recording started with no chat on screen. Only the
       * first two are a session, and the URL half is which engine. */
      if (e.f.session) {
        const [head, tail] = e.f.session.includes("|") ? e.f.session.split("|") : ["", e.f.session];
        if (/^w\S*:p/.test(tail)) id.sessions.add(tail);
        if (head.startsWith("ws")) id.engines.add(head.replace(/^ws/, "http").replace(/\/ws$/, ""));
      }
      if (e.f.dev) id.devs.add(e.f.dev);
      if (e.f.pg) id.pages.add(e.f.pg);
      if (e.f.engine) id.engines.add(e.f.engine);
    }
    return grew;
  };

  /* THE HOP NOTHING LOGS AT EITHER END.
     *
     * A recording held as a block in the composer is uploaded through
     * client.ts uploadFile -> POST /upload, and that path writes no line in the
     * browser and none in the engine. So the capture id and the upload id the
     * engine minted for those very bytes never appear on one line anywhere.
     * Measured on 2026-08-05: six sends carried `send.words-deferred` and the
     * app logged exactly one `upload.start` all day.
     *
     * What does cross is the byte count: `capture.clip bytes=76194` in the
     * browser and `words.start upload=… bytes=76194` in the engine. It is only
     * taken when that many bytes is UNIQUE in the engine's log for five minutes
   * either side -- two identical sizes and this would silently pick one, and
   * a wrong join is worse than a gap. */
  const byteBridge = () => {
    let grew = false;
    for (const clipEv of events) {
      if (clipEv.event !== "capture.clip" || !clipEv.f.cid || !clipEv.f.bytes) continue;
      if (!id.cids.has(clipEv.f.cid)) continue;
      const hits = events.filter((e) =>
        e.service === "engine" && e.f.bytes === clipEv.f.bytes &&
        (e.event === "words.start" || e.event === "user-audio.stored" || e.event === "rescue.start") &&
        Math.abs(e.ts - clipEv.ts) <= 300_000);
      const ups = new Set(hits.flatMap((e) => split(e.f.upload ?? e.f.msgId ?? "")));
      if (hits.length !== 1 || ups.size !== 1) continue;
      const up = [...ups][0];
      if (id.uploads.has(up)) continue;
      id.uploads.add(up); grew = true;
      id.joins.push({
        how: `upload ${short(up)} is this recording's bytes`,
        exact: false,
        evidence: `capture.clip bytes=${clipEv.f.bytes} and ${hits[0].event} bytes=${clipEv.f.bytes}, ` +
          `the only engine line with that size within five minutes (${hits[0].file}:${hits[0].line}). ` +
          `Nothing logs POST /upload at either end, so there is no id to join on.`,
      });
    }

    // and the same bridge walked the other way, for a question that starts at
    // the wire cid: which recording did the engine read those bytes out of?
    for (const e of events) {
      if (e.service !== "engine" || e.event !== "words.start" || !e.f.bytes) continue;
      if (!split(e.f.upload ?? "").some((u) => id.uploads.has(u))) continue;
      const hits = events.filter((c) =>
        c.event === "capture.clip" && c.f.bytes === e.f.bytes && c.f.cid &&
        (!id.devs.size || id.devs.has(c.f.dev ?? "")) && Math.abs(c.ts - e.ts) <= 300_000);
      if (hits.length !== 1 || id.cids.has(hits[0].f.cid!)) continue;
      id.cids.add(hits[0].f.cid!); grew = true;
      id.joins.push({
        how: `recording ${hits[0].f.cid} is the bytes the engine read`,
        exact: false,
        evidence: `words.start bytes=${e.f.bytes} and capture.clip bytes=${e.f.bytes}, the only ` +
          `recording that size within five minutes (${hits[0].file}:${hits[0].line})`,
      });
    }
    return grew;
  };

  /* THE ONE JOIN THE LOG DOES NOT MAKE FOR US.
     *
     * A message composed from held recordings sends `send.words-deferred
     * uploads=…` and then `send.utterance cid=…`, and NEITHER line carries the
     * other's id. The engine's `utterance.in cid=… upload=…` welds them, so
     * when the engine's log is here this is never needed. When the engine is on
     * another host it is the only bridge there is, and it is adjacency, not
   * identity: same device, same page, same session, milliseconds apart. It is
   * marked as a guess wherever it is used, and it is only reached when the
   * exact passes have already run out -- when the engine's log is here, this
   * never fires at all. */
  const adjacency = () => {
    let grew = false;
    for (let i = 0; i < events.length; i++) {
      const d = events[i];
      if (d.event !== "send.words-deferred") continue;
      // the send this deferral belongs to: the first frame from the same page
      let s: Ev | null = null;
      for (let j = i + 1; j < events.length && events[j].ts - d.ts <= ADJ; j++) {
        const c = events[j];
        if (c.event === "send.utterance" && c.f.dev === d.f.dev && c.f.pg === d.f.pg) { s = c; break; }
      }
      if (!s?.f.cid) continue;
      const ups = split(d.f.uploads ?? "");

      /* WHICH RECORDINGS THOSE UPLOADS ARE.
       *
       * When the engine is on another host, nothing here ever says which
       * capture became which upload id: the id that welds them is minted at
       * POST /upload and logged by neither end. What this page did log is the
       * blocks it put in the composer -- `clip.held` -- since its last send.
       * Claimed only when the COUNT matches the number of uploads in the
       * deferral, so a block composed for a later message cannot be dragged in
       * silently. */
      const heldSince: Ev[] = [];
      for (let k = i - 1; k >= 0; k--) {
        const p = events[k];
        if (p.f.dev !== d.f.dev || p.f.pg !== d.f.pg) continue;
        if (p.event === "send.utterance") break;
        if (p.event === "clip.held" && p.f.cid) heldSince.unshift(p);
      }

      const knowUploads = ups.some((u) => id.uploads.has(u));
      const knowWire = id.cids.has(s.f.cid);
      const knowHeld = heldSince.some((h) => id.cids.has(h.f.cid!));
      // this send has to be OURS by something already established
      if (!knowUploads && !knowWire && !knowHeld) continue;

      const evidence = `send.words-deferred and send.utterance, same device and page, ` +
        `${s.ts - d.ts}ms apart (${s.file}:${s.line})`;
      if (!knowWire) {
        id.cids.add(s.f.cid); grew = true;
        id.joins.push({ how: `wire cid ${short(s.f.cid)} is this message's frame`, exact: false, evidence });
      }
      if (!knowUploads && ups.length) {
        for (const u of ups) id.uploads.add(u);
        grew = true;
        id.joins.push({
          how: `this frame carried recording(s) ${ups.map(short).join(", ")}`,
          exact: false, evidence,
        });
      }
      if (!knowHeld && heldSince.length && heldSince.length === ups.length) {
        for (const h of heldSince) id.cids.add(h.f.cid!);
        grew = true;
        id.joins.push({
          how: `recording(s) ${heldSince.map((h) => h.f.cid!).join(", ")} are the blocks this send carried`,
          exact: false,
          evidence: `${heldSince.length} clip.held on this page since its last send, and the ` +
            `deferral names ${ups.length} upload(s) (${heldSince[0].file}:${heldSince[0].line})`,
        });
      }
    }
    return grew;
  };

  /* Is there a LINE anywhere that puts a known cid and a known upload together?
   * When there is, adjacency is not needed and must not run: guessing over the
   * top of a fact is how a tool starts stating things it does not know. */
  const linkedByLine = () => events.some((e) => {
    const { cids, ups } = idsOf(e);
    return cids.some((c) => id.cids.has(c)) && ups.some((u) => id.uploads.has(u));
  });

  const settle = () => { while (exactPass() || byteBridge()) { /* to a fixed point */ } };
  settle();
  if (!linkedByLine() && adjacency()) settle();

  /* A uuid on the command line is ambiguous -- an upload id and a wire cid look
   * identical -- so it was seeded into both spaces. Whichever guess the log
   * never confirmed is dropped here, because a message left holding a phantom
   * upload id reads as "this one carried a recording" and it did not. */
  const inField = (fields: string[], v: string) =>
    events.some((e) => fields.some((k) => e.f[k] && split(e.f[k]).includes(v)));
  for (const u of [...id.uploads]) if (!inField(UPLOAD_FIELDS, u)) id.uploads.delete(u);
  for (const c of [...id.cids]) if (!inField(CID_FIELDS, c) && id.uploads.has(c)) id.cids.delete(c);
  return id;
}

/** Every event that belongs to this message. */
export function eventsFor(events: Ev[], id: Identity): Ev[] {
  const out: Ev[] = [];
  for (const e of events) {
    const vals: string[] = [];
    for (const k of CID_FIELDS) if (e.f[k]) vals.push(...split(e.f[k]));
    for (const k of UPLOAD_FIELDS) if (e.f[k]) vals.push(...split(e.f[k]));
    if (vals.some((v) => id.cids.has(v) || id.uploads.has(v))) out.push(e);
  }
  return out;
}

/* The recording's own bytes, which is the only thread through two hops that
 * carry no id at all: the device transcript (`stt.batch.*` logs bytes, mime and
 * nothing else) and the engine's read of a block (`words.start bytes=`). Same
 * device, same page, same byte count, inside a minute. A guess, and printed as
 * one. */
export function byBytes(events: Ev[], mine: Ev[], id: Identity): Ev[] {
  const clip = mine.find((e) => e.event === "capture.clip" && e.f.bytes);
  if (!clip) return [];
  const bytes = clip.f.bytes;
  return events.filter((e) =>
    e.service === "app" && e.event.startsWith("stt.batch.") &&
    e.f.bytes === bytes && e.f.dev === clip.f.dev && e.f.pg === clip.f.pg &&
    Math.abs(e.ts - clip.ts) < 60_000 && !mine.includes(e) && id.devs.has(e.f.dev ?? ""));
}

/* ------------------------------------------------------------------- the hops */

export type Hop = {
  key: string;
  title: string;
  who: string;                 // which service should have written it
  match: (e: Ev) => boolean;
  /** Set when nothing in the code writes a line for this hop at all. */
  unlogged?: string;
  /* Some hops are logged on one path through the code and on no other, so
   * whether an absence is a blind spot depends on which path THIS message took.
   * Returns the reason when this message's own hop was never going to be
   * written, and null when the absence is a real absence. */
  whenMissing?: (ctx: { id: Identity; mine: Ev[] }) => string | null;
  /* Returns a reason when this hop was never part of THIS message's route at
   * all -- a typed message has no recording to record. Absence there is not a
   * hole in the trail and must not be listed as one, or the list that matters
   * drowns in hops that were never going to happen. */
  na?: (ctx: { id: Identity; mine: Ev[] }) => string | null;
};

/** True when nothing about this message says a recording was ever involved. */
const noRecording = (id: Identity) =>
  ![...id.cids].some((c) => c.startsWith("c-")) && id.uploads.size === 0;

/** A recording sent as its own message, rather than as a block in a composition. */
const isVoiceNote = (mine: Ev[]) =>
  mine.some((e) => (e.event === "send.utterance" || e.event === "utterance.in") &&
    e.f.kind === "voice") && !mine.some((e) => e.event === "send.words-deferred");

/** A recording released into the composer to go with the next send. */
const heldAsBlock = (mine: Ev[]) =>
  mine.some((e) => e.event === "clip.held" || e.event === "send.words-deferred");

export const HOPS: Hop[] = [
  { key: "press", title: "the send was pressed", who: "app",
    match: (e) => e.event === "send.pressed",
    unlogged: "" },
  { key: "record", title: "the microphone opened and closed", who: "app",
    match: (e) => ["capture.start", "capture.released", "capture.cancelled", "capture.abandoned",
      "voice.interrupted"].includes(e.event),
    na: ({ id }) => noRecording(id) ? "no recording is named anywhere in this message" : null },
  { key: "clip", title: "the recording became bytes", who: "app",
    match: (e) => ["capture.clip", "capture.clip.none", "capture.clip.threw", "clip.held",
      "clip.vault.parked"].includes(e.event),
    na: ({ id }) => noRecording(id) ? "no recording is named anywhere in this message" : null },
  { key: "heard", title: "this device transcribed it", who: "app",
    match: (e) => ["stt.batch.start", "stt.batch.done", "stt.batch.rejected", "stt.batch.unreachable",
      "capture.verdict", "capture.verdict.late", "utterance", "utterance.held", "ignored",
      "ignored.held"].includes(e.event),
    na: ({ id }) => noRecording(id) ? "no recording is named anywhere in this message" : null },
  { key: "compose", title: "it went into the composer", who: "app",
    match: (e) => ["draft.created", "draft.refused", "clip.no-bubble", "utterance.no-bubble",
      "release.no-draft", "release.no-clip"].includes(e.event),
    /* A bubble is only drawn from a recording's own draft. A typed message has
     * no draft line, and a held block deliberately has none either: the words
     * fill the card that is already on screen. */
    na: ({ id, mine }) => noRecording(id) ? "no recording is named anywhere in this message"
      : heldAsBlock(mine) ? "this recording went in as a block, and a block draws no draft " +
        "bubble of its own: its words fill the card already on screen"
      : null },
  { key: "upload", title: "the bytes reached the engine", who: "app + engine",
    match: (e) => e.event.startsWith("upload.") || e.event.startsWith("user-audio.") ||
      e.event === "clip.upload-failed",
    /* A voice note goes through uploadAudio -> POST /user-audio, which logs
     * upload.start, upload.done and the engine's user-audio.stored. A recording
     * held as a BLOCK in the composer goes through uploadFile -> POST /upload,
     * which logs nothing in the browser and nothing in the engine. So when this
     * message has an upload id and no line for it, the bytes did arrive -- the
     * engine read them -- and the hop simply is not written down. */
    whenMissing: ({ id, mine }) =>
      id.uploads.size && mine.some((e) => e.service === "engine")
        ? "the engine holds these bytes (its own lines below name the upload id), so they got " +
          "there. Nothing wrote the trip: a recording held as a block in the composer is posted " +
          "to /upload, and neither the browser (client.ts uploadFile) nor the engine logs that " +
          "route. On 2026-08-05 six sends carried held recordings and the app logged one " +
          "upload.start all day."
        : null,
    na: ({ id }) => noRecording(id) ? "nothing was uploaded: this message is text" : null },
  { key: "gate", title: "what the send waited for", who: "app",
    match: (e) => ["send.upload-wait", "send.words-gate", "send.words-deferred", "send.words-wait",
      "send.words-unsettled"].includes(e.event),
    /* The gates are on the composer's staged blocks. A voice note is its own
     * message and goes the moment it is transcribed, so there was never a gate
     * to log. `send.upload-wait` and `send.words-gate` landed on 2026-08-05;
     * before that build a composition logged only the deferral. */
    na: ({ mine }) => isVoiceNote(mine)
      ? "a voice note is its own message and waits for nothing in the composer" : null },
  { key: "wire", title: "the frame went on the wire", who: "app",
    match: (e) => ["send.utterance", "send.queued", "send.requeued", "send.dropped",
      "send.promise-withdrawn", "send.unacked-dropped"].includes(e.event) },
  { key: "in", title: "the engine took it", who: "engine",
    match: (e) => e.event === "utterance.in" || e.event === "utterance.threw" },
  { key: "words", title: "the engine read the recording", who: "engine",
    match: (e) => e.event.startsWith("words.") || e.event.startsWith("rescue."),
    /* The engine reads a recording in two cases only: a marker to fill in, and
     * a voice note that arrived with no words at all (the rescue). A voice note
     * whose device already transcribed it gives the engine nothing to do. */
    na: ({ id, mine }) => noRecording(id) ? "nothing for the engine to read: this message is text"
      : isVoiceNote(mine) && mine.some((e) => e.event === "utterance.in" && Number(e.f.chars) > 0)
        ? "the device sent the words with the recording, so the engine had nothing to read: it " +
          "only transcribes a marker it was asked to fill, or a voice note that arrived empty"
      : null },
  { key: "accept", title: "the engine accepted it", who: "engine",
    match: (e) => ["utterance.accepted", "utterance.dropped", "utterance.clip-forgotten",
      "utterance.rescue-failed"].includes(e.event) },
  { key: "deliver", title: "it was typed into the pane", who: "engine",
    match: (e) => ["utterance.delivered", "utterance.delivery-failed"].includes(e.event) },
  { key: "echo", title: "the engine's copy came back to the app", who: "app",
    match: (e) => ["commit.start", "commit.dropped", "commit.no-bubble", "note.safe", "note.failed",
      "note.discarded", "handoff.stood-down", "clip.vault.released"].includes(e.event),
    /* The settle writes no line. store.ts turns the optimistic bubble into the
     * engine's copy inside the `chat` handler and logs nothing there; only a
     * voice note logs anything on this side (commit.start, note.safe). So for a
     * typed message or a composition, whether the app ever drew the finished
     * bubble is not recorded -- and "it seemed to send and then it was not
     * there" is a question about exactly this hop. */
    whenMissing: ({ mine }) => isVoiceNote(mine) ? null
      : "the app writes nothing when the engine's copy settles its bubble. store.ts does it in " +
        "the `chat` handler with no log line; only a voice note logs commit.start and note.safe. " +
        "Whether this device ever saw its own message come back is therefore unknowable from " +
        "the logs, on any host." },
  { key: "reply", title: "the agent's answer went out", who: "engine + app-server",
    match: () => false,
    unlogged: "nothing ties a reply to the message that caused it. The engine's [notify] " +
      "lines and the app server's push.notify name a SESSION and a msg= of their own, so the " +
      "most that can be said is which reply came next in this session (shown below when there " +
      "is one). Whether the app spoke it, and when, is not logged at all: the phone writes no " +
      "line when audio starts.",
  },
];

/* Hops whose absence is a fact about the CODE, not about this message. Each
 * string is the reason, printed verbatim where the hop should have been. */
const NEVER_LOGGED: Record<string, string> = {
  press: "no build before 2026-08-05 logged the press. `send.pressed` landed today on the " +
    "app's fix/send-still-waits; a line older than that build cannot have it, which is " +
    "exactly why today's send-latency question had to be answered from the gaps between " +
    "other lines.",
};

/* ----------------------------------------------------------------- the clock */

export type Skew = { lo: number; hi: number; pairs: number; how: string };

/* How far the phone's clock is from the engine host's, measured, not assumed.
 *
 * The browser stamps its own lines (app/src/shared/logging.ts) and ships them to the
 * app server, which appends them unchanged on purpose -- so an app line's time
 * is a PHONE's idea of now and an engine line's is a laptop's. Measured over
 * this file's own history the gap has been as much as 1.07s, which is more than
 * most of the intervals anyone wants to read off it.
 *
 * Both bounds come from causality, one direction each:
 *
 *   the app cannot log the start of an upload after the engine logged storing
 *   it   ->  offset > start - stored
 *   the app cannot log the upload's answer before the engine stored it
 *        ->  offset < done - stored
 *
 * so a single upload brackets the offset from both sides, and network time is
 * inside the bracket rather than confused with it. */
export function measureSkew(events: Ev[], dev: string | undefined, around: number): Skew | null {
  const starts = new Map<string, number>(), dones = new Map<string, number>(), stored = new Map<string, number>();
  const sends = new Map<string, number>(), ins = new Map<string, number>();
  for (const e of events) {
    if (dev && e.service === "app" && e.f.dev && e.f.dev !== dev) continue;
    const cid = e.f.cid;
    if (!cid) continue;
    if (e.event === "upload.start") starts.set(cid, e.ts);
    else if (e.event === "upload.done") dones.set(cid, e.ts);
    else if (e.event === "user-audio.stored") stored.set(cid, e.ts);
    else if (e.event === "send.utterance") sends.set(cid, e.ts);
    else if (e.event === "utterance.in") ins.set(cid, e.ts);
  }
  const WINDOW = 2 * 3600_000;
  const near = (t: number) => Math.abs(t - around) <= WINDOW;

  /* One bracket per upload, and the SPREAD of them reported rather than their
   * intersection. A phone's clock drifts and gets corrected: over these files
   * it has been a full second ahead one day and level the next, so intersecting
   * a whole window's brackets produces an empty interval and an empty interval
   * would be printed as a fact. The spread is what is actually known. */
  const mids: number[] = [];
  for (const [cid, st] of stored) {
    if (!near(st)) continue;
    const a = starts.get(cid), d = dones.get(cid);
    if (a === undefined || d === undefined) continue;
    mids.push((a - st + (d - st)) / 2);
  }
  if (mids.length) {
    return {
      lo: Math.min(...mids), hi: Math.max(...mids), pairs: mids.length,
      how: "each is one upload's own round trip seen from both sides, so network time is " +
        "inside the bracket rather than confused with the offset",
    };
  }
  // one-sided, and better than nothing: a frame cannot arrive before it is sent
  let floor = -Infinity, n = 0;
  for (const [cid, t] of sends) {
    const i = ins.get(cid);
    if (i !== undefined && near(i)) { floor = Math.max(floor, t - i); n++; }
  }
  if (!n || floor === -Infinity) return null;
  return { lo: floor, hi: NaN, pairs: n,
    how: "one-sided: no upload near this message was seen from both ends, so this is a floor " +
      "on the offset and not a bracket" };
}

/* ---------------------------------------------------------------- rendering */

const hhmmss = (ts: number) => new Date(ts).toISOString().slice(11, 23);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Does a service's log even cover this minute? The difference between "the
 *  engine says it did not happen" and "no engine log here can say". */
function coverage(events: Ev[], service: string, at: number, spanMs = 60_000) {
  return events.filter((e) => e.service === service && Math.abs(e.ts - at) <= spanMs).length;
}

/* WHICH ENGINE THIS MESSAGE WAS ADDRESSED TO, and which one wrote the log here.
 *
 * He runs several engines: two ports on this laptop and at least one on linux,
 * with one app open across all of them. `send.utterance session=w7:pN` names a
 * session and not a host, so "the engine log has nothing for this message" is
 * a claim about the wrong engine unless the host is checked -- and the session
 * ids are per-engine, so they collide across hosts too. The app's other lines
 * for the same session carry the socket URL (`session=wss://host/ws|w7:pN`),
 * and the engine's own [notify] prints start with the host it thinks it is. */
export function addressedHost(events: Ev[], id: Identity, at: number): string | null {
  let best: { host: string; d: number } | null = null;
  for (const e of events) {
    if (e.service !== "app" || !e.f.session?.includes("|")) continue;
    const [url, sid] = e.f.session.split("|");
    if (!id.sessions.has(sid)) continue;
    if (id.devs.size && e.f.dev && !id.devs.has(e.f.dev)) continue;
    const host = url.replace(/^wss?:\/\//, "").replace(/\/.*$/, "");
    const d = Math.abs(e.ts - at);
    if (!best || d < best.d) best = { host, d };
  }
  return best?.host ?? null;
}

/** The host the engine writing these logs believes it is, from its own prints. */
export function localEngineHost(notes: Note[]): string | null {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const m = /^\[notify\] \S+ ([A-Za-z0-9_.-]+):\S+/.exec(n.text);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best?.[0] ?? null;
}

/** Same machine? Hostnames are written short in one place and fully qualified
 *  in the other (`macbook-air` vs `macbook-air.tail0a1b2c.ts.net:8444`). */
export function sameHost(a: string, b: string): boolean {
  const bare = (s: string) => s.split(":")[0].split(".")[0].toLowerCase();
  return bare(a) === bare(b);
}

export type HopResult = {
  key: string;
  found: number;
  missing: boolean;
  /** found | unlogged (nothing writes it) | unreachable (no log covers it here) | absent */
  reason: "found" | "unlogged" | "unreachable" | "absent" | "n/a";
};
export type Report = { text: string; hops: HopResult[] };

export function render(all: Sources, id: Identity, seed: string, opts: { raw?: boolean } = {}): Report {
  const mine = eventsFor(all.events, id);
  const guessed = byBytes(all.events, mine, id);
  const timeline = [...mine, ...guessed].sort((a, b) => a.ts - b.ts);
  const out: string[] = [];
  const hops: Report["hops"] = [];

  if (!timeline.length) {
    out.push(`journey ${seed}`);
    out.push("");
    out.push(`  Nothing anywhere carries that id. Logs read: ${all.files.map((f) => f.path).join(", ")}.`);
    out.push("  Either the id is wrong, or it is older than these files: the stdout logs are");
    out.push("  truncated on every restart and .run/logs keeps one rotated generation.");
    return { text: out.join("\n"), hops };
  }

  const first = timeline[0].ts, last = timeline[timeline.length - 1].ts;
  const dev = [...id.devs][0];
  const wire = timeline.find((e) => e.event === "send.utterance");
  const skew = measureSkew(all.events, dev, wire?.ts ?? first);

  const capture = [...id.cids].filter(isCapture);
  /* The cid on the frame, which is a DIFFERENT id from the capture on a
   * composition and the SAME one on a voice note -- a voice note is sent under
   * the id its recording was minted with. Printing "wire (none found)" for one
   * would read as a send that never happened. */
  const onFrames = new Set(mine
    .filter((e) => e.event === "send.utterance" || e.event === "utterance.in")
    .map((e) => e.f.cid).filter(Boolean) as string[]);
  const wires = [...id.cids].filter((c) => !isCapture(c) || onFrames.has(c));

  out.push(`journey ${seed}`);
  out.push(`  capture ${capture.join(", ") || "(none: this message carried no recording)"}`);
  out.push(`  upload  ${[...id.uploads].join(", ") || "(none)"}`);
  out.push(`  wire    ${wires.join(", ") || "(none found)"}` +
    (wires.length && capture.length && wires.every((w) => isCapture(w))
      ? "   (the recording's own id: a voice note is sent under it)" : ""));
  out.push(`  session ${[...id.sessions].join(", ") || "(unknown)"}   device ${dev ?? "?"}` +
    `   page ${[...id.pages].join(", ") || "?"}`);
  const addressed = addressedHost(all.events, id, wire?.ts ?? first);
  const local = localEngineHost(all.notes);
  if (addressed) {
    out.push(`  engine  ${addressed}` +
      (local ? (sameHost(addressed, local) ? `   (this machine: ${local})` :
        `   NOT this machine, whose engine log is ${local}'s`) : ""));
  } else {
    for (const e of id.engines) out.push(`  engine  ${e}`);
  }
  out.push("");

  out.push("  clocks");
  if (skew) {
    const s = (ms: number) => `${(ms / 1000).toFixed(3)}s`;
    const said = Number.isNaN(skew.hi)
      ? `at least ${s(skew.lo)} ahead of the engine host's`
      : skew.lo === skew.hi
        ? `${s(skew.lo)} ahead of the engine host's (negative means behind)`
        : `between ${s(skew.lo)} and ${s(skew.hi)} ahead of the engine host's (negative means behind)`;
    for (const l of wrap(
      `the browser's clock ran ${said}, from ${skew.pairs} crossing(s) within two hours of this ` +
      `message; ${skew.how}. Times below are printed AS LOGGED and are never corrected, so an ` +
      `interval between an app line and an engine line only means something if it is bigger ` +
      `than that.`, 92)) {
      out.push(`    ${l}`);
    }
  } else {
    out.push("    no crossing near this message pairs an app line with an engine line, so the");
    out.push("    offset between the browser's clock and the engine host's is UNMEASURED here.");
    out.push("    App-to-engine intervals below may be off by a second in either direction; the");
    out.push("    widest measured gap in these files is 1.07s.");
  }
  out.push("");

  const shown = new Set<Ev>();
  for (const hop of HOPS) {
    const found = timeline.filter((e) => hop.match(e));
    for (const e of found) shown.add(e);

    out.push(`  ${hop.title}   [${hop.who}]`);
    if (found.length) {
      hops.push({ key: hop.key, found: found.length, missing: false, reason: "found" });
      for (const e of found) {
        const fields = e.text.slice(e.iso.length + e.service.length + e.event.length + 3).trim();
        const tag = guessed.includes(e) ? "  ~guess: matched on byte count, not on an id" : "";
        out.push(`    ${hhmmss(e.ts)}  ${e.service.padEnd(10)} ${e.event.padEnd(22)} ` +
          `${opts.raw ? fields : clip(fields, 110)}`);
        out.push(`      ${e.file}:${e.line}${tag}`);
      }
    } else {
      const na = hop.na?.({ id, mine }) ?? null;
      const why = hop.unlogged !== undefined
        ? (NEVER_LOGGED[hop.key] ?? hop.unlogged)
        : (hop.whenMissing?.({ id, mine }) ?? null);
      const svc = hop.who.includes("engine") ? "engine" : "app";
      const elsewhere = svc === "engine" && addressed && local && !sameHost(addressed, local)
        ? `${addressed} answered this send and this machine's engine log is ${local}'s`
        : null;
      if (na) {
        hops.push({ key: hop.key, found: 0, missing: false, reason: "n/a" });
        const lines = wrap(`not on this message's route: ${na}.`, 92);
        out.push(`    ${lines[0]}`);
        for (const l of lines.slice(1)) out.push(`      ${l}`);
      } else if (why) {
        // structural first: a hop nothing writes is missing on every host
        hops.push({ key: hop.key, found: 0, missing: true, reason: "unlogged" });
        out.push(`    MISSING, and nothing would have written it:`);
        for (const l of wrap(why, 92)) out.push(`      ${l}`);
      } else if (elsewhere) {
        hops.push({ key: hop.key, found: 0, missing: true, reason: "unreachable" });
        out.push(`    MISSING, and this machine cannot say: ${elsewhere}.`);
        out.push(`      The line that would answer this is in ${addressed}'s own .run, not here.`);
      } else {
        const near = coverage(all.events, svc, wire?.ts ?? first);
        if (near === 0) {
          hops.push({ key: hop.key, found: 0, missing: true, reason: "unreachable" });
          out.push(`    MISSING, and this machine cannot say: no ${svc} line at all within a minute`);
          out.push(`      of this message. The app addressed ${addressed ?? [...id.engines][0] ?? "(no engine logged)"};`);
          out.push(`      if that is another host, the log that would answer this is on that host.`);
        } else {
          hops.push({ key: hop.key, found: 0, missing: true, reason: "absent" });
          out.push(`    MISSING: no line for this message. The ${svc} log does cover this minute`);
          out.push(`      (${near} other lines), so this is an absence and not a blind spot.`);
        }
      }
    }
    out.push("");
  }

  const rest = timeline.filter((e) => !shown.has(e));
  if (rest.length) {
    out.push("  other lines carrying these ids");
    for (const e of rest) {
      out.push(`    ${hhmmss(e.ts)}  ${e.service.padEnd(10)} ${e.event.padEnd(22)} ` +
        `${clip(e.text.slice(e.iso.length + e.service.length + e.event.length + 3).trim(), 110)}`);
    }
    out.push("");
  }

  /* The engine's untimestamped prints that sit inside this message's stretch of
   * the file. They cannot be sorted, so they are shown where they physically
   * are, with the time of the line above them. */
  const engineLines = timeline.filter((e) => e.service === "engine");
  if (engineLines.length) {
    const files = new Set(engineLines.map((e) => e.file));
    const lo = Math.min(...engineLines.map((e) => e.line));
    const hi = Math.max(...engineLines.map((e) => e.line));
    const near = all.notes.filter((n) => files.has(n.file) && n.line >= lo - 3 && n.line <= hi + 12 &&
      [...id.sessions, ...id.cids, ...id.uploads].some((v) => n.text.includes(v)));
    if (near.length) {
      out.push("  the engine's own prints, which carry no timestamp");
      for (const n of near) {
        out.push(`    after ${hhmmss(n.after)}  ${clip(n.text, 110)}`);
        out.push(`      ${n.file}:${n.line}`);
      }
      out.push("");
    }
  }

  out.push("  where the trail goes cold");
  const missing = hops.filter((h) => h.missing);
  if (!missing.length) out.push("    nowhere: every hop has a line.");
  const said: Record<string, string> = {
    unlogged: "nothing in the code writes this hop down",
    unreachable: "no log on this machine can answer it",
    absent: "the log covers that minute and has no line for this message",
  };
  for (const m of missing) {
    const hop = HOPS.find((h) => h.key === m.key)!;
    out.push(`    ${hop.title}: ${said[m.reason]}`);
  }
  out.push(`    the app's own speech-to-text service writes .run/stt.log, and that file has no`);
  out.push(`    identifiers in it at all (just "Transcribing ..." and an inference time), so no`);
  out.push(`    line of it can be attached to a message. It is not read here.`);
  out.push(`    span ${hhmmss(first)} to ${hhmmss(last)}, ${((last - first) / 1000).toFixed(3)}s, ` +
    `${timeline.length} lines from ${new Set(timeline.map((e) => e.file)).size} file(s).`);

  /* HOW EACH ID WAS TIED TO THE LAST, printed with the report and not behind a
   * flag. Every hop above rests on these, and a join made on a byte count and a
   * five-minute window is not the same claim as one made on a line that carries
   * both ids -- so the two are never allowed to look alike. */
  if (id.joins.length) {
    out.push("");
    out.push("  how the ids were joined");
    for (const j of id.joins) {
      out.push(`    ${j.exact ? "exact" : "GUESS"}  ${j.how}`);
      for (const l of wrap(j.evidence, 86)) out.push(`             ${l}`);
    }
  }

  return { text: out.join("\n"), hops };
}

function wrap(s: string, n: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > n) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/* --------------------------------------------------------------------- CLI */

/** Sends in a session near a time, for when all anyone has is "around then". */
export function candidates(events: Ev[], session: string, at: number, windowMs: number): Ev[] {
  return events.filter((e) =>
    (e.event === "send.utterance" || e.event === "utterance.in") &&
    (e.f.session ?? "").split("|").pop() === session &&
    Math.abs(e.ts - at) <= windowMs);
}

/* "18:55" or "2026-08-05T18:55" or a full ISO stamp. A bare time means today in
 * UTC, because that is what every line in these files is written in. */
export function parseAt(s: string, now = new Date()): number {
  if (/^\d\d:\d\d(:\d\d)?$/.test(s)) {
    const day = now.toISOString().slice(0, 10);
    return Date.parse(`${day}T${s.length === 5 ? s + ":00" : s}Z`);
  }
  const t = Date.parse(s.endsWith("Z") ? s : s + "Z");
  return Number.isFinite(t) ? t : NaN;
}

async function main(argv: string[]) {
  const args = argv.slice(2);
  let root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  let session = "", at = "", raw = false, windowMs = 120_000;
  const seeds: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--root") root = args[++i];
    else if (a === "--session") session = args[++i];
    else if (a === "--at") at = args[++i];
    else if (a === "--window") windowMs = Number(args[++i]) * 1000;
    else if (a === "--raw") raw = true;
    else if (a === "-h" || a === "--help") { console.log(HELP); return 0; }
    else seeds.push(a);
  }
  if (!seeds.length && !session) { console.log(HELP); return 2; }

  const all = loadSources(root);
  if (!all.files.length) {
    console.error(`journey: no logs under ${root}/.run. Point --root at the checkout whose ` +
      `engine wrote them.`);
    return 1;
  }

  if (!seeds.length) {
    const when = at ? parseAt(at) : Date.now();
    if (!Number.isFinite(when)) { console.error(`journey: cannot read a time from "${at}".`); return 2; }
    /* One send is two lines when both ends of it are logged here (the app's
     * frame and the engine's receipt), and they carry the same cid. Offering
     * the same message twice as two choices is the tool being confused in
     * public, so the list is by cid. */
    const byCid = new Map<string, Ev>();
    for (const e of candidates(all.events, session, when, windowMs)) {
      if (e.f.cid && !byCid.has(e.f.cid)) byCid.set(e.f.cid, e);
    }
    const c = [...byCid.values()];
    if (!c.length) {
      console.error(`journey: no send in ${session} within ${windowMs / 1000}s of ` +
        `${new Date(when).toISOString()}. Widen it with --window <seconds>.`);
      return 1;
    }
    if (c.length > 1) {
      console.log(`${c.length} sends in ${session} near ${new Date(when).toISOString()}; ` +
        `run one of these ids:\n`);
      for (const e of c) {
        console.log(`  ${hhmmss(e.ts)}  ${e.f.cid}  ${e.f.kind ?? "text"}, ${e.f.chars ?? "?"} chars` +
          (e.f.text ? `: ${clip(e.f.text, 50)}` : ""));
      }
      return 0;
    }
    seeds.push(c[0].f.cid!);
  }

  const id = resolve(all.events, seeds);
  const rep = render(all, id, seeds.join(" "), { raw });
  console.log(rep.text);
  return 0;
}

const HELP = `journey: one message's whole life, across the browser, the app server and the engine.

  scripts/journey.sh <id>                 a capture cid, an upload id or a wire cid
  scripts/journey.sh --session w9:p4 --at 18:55
  scripts/journey.sh <id> --raw           do not truncate the fields
  scripts/journey.sh <id> --root DIR      read another checkout's .run

Reads, and only reads: .run/engine.log, .run/frontend.log and .run/logs/*.log(.1).
Every hop with no line is printed as missing, with which of the three reasons it is.`;

if (import.meta.main) process.exit(await main(process.argv));
