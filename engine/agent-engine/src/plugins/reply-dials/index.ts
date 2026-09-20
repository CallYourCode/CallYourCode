/* THE REPLY DIALS, AS A PLUGIN (#585).
 *
 * verbosity, complexity and the prompt-bits menu, moved out of server.ts into
 * one module that owns their state, their wording, their delivery instruction
 * and the composer widgets the app draws. server.ts keeps the reply trace
 * (noteDelivery/writeHookState, the Stop hook's evidence) and calls into here
 * for what to append to a message (askFor). The dials are a pure input
 * transform now: a soft nudge, never enforced.
 *
 * WHY ENGINE-GLOBAL, ONE FILE. Today the engine already keeps ONE
 * level/complexity for the whole host; the app server was the cross-host mirror.
 * The plugin keeps that engine-global state in its OWN file (the engine-scoped
 * plugin data dir's reply-dials.json, the design)
 * and the app server holds nothing. Two hosts can sit at different dials; the
 * composer shows and sets the dials of the engine that owns the active session.
 *
 * WHY THE WORDING DEFAULTS LIVE HERE NOW. The five verbosity names+texts,
 * five complexity names+texts and the prompt bits are compiled in, byte-identical
 * to the app's config/replyStrings.ts. State stores overrides SPARSELY. The
 * consequence, deliberate: a fresh engine appends the DEFAULT text (closes the
 * cold-engine silence), where before an unpushed rung appended
 * nothing.
 *
 * WHY PER-DIAL GATING, NOT ONE append. verbosityOn gates the verbosity
 * string; complexityOn gates the complexity string; promptBitsOn hides the bits
 * menu. A toggle that is off keeps its value.
 *
 *   bun test agent-engine/src/plugins/reply-dials/reply-dials.test.ts
 */

import {
  type ComposerWidgetDecl,
  type PluginSpec,
  type RpcCtx,
  MENU_MAX_ITEMS,
  MENU_ITEM_TEXT_MAX,
} from "../platform/spec.ts";
import { mkdirPrivate, writePrivate } from "../../../../shared/runfiles.ts";
import { pluginDataDir } from "../../storage/datadir.ts";
/* The typed PluginCore, for the ONE capability this plugin registers when it
 * loads: its own delivery-time input transform (core.inputTransform). */
import type { PluginCore } from "../platform/core.ts";

/* ---- the compiled-in defaults (byte-identical to A:config/replyStrings.ts) --- */

/** The five rungs of each scale, 1..5, ascending. */
export const RUNGS = [1, 2, 3, 4, 5] as const;

/* A valid verbosity rung is one the names table knows, mirroring the complexity
 * check (DEFAULT_COMPLEXITY_NAMES). The old REPLY_LEVEL_NEEDS table doubled as
 * this gate; it is gone now that the Stop hook is verbosity-unaware, so rung
 * validity reads off the names it displays instead. */
export const validRung = (n: unknown): n is number =>
  typeof n === "number" && DEFAULT_REPLY_NAMES[n] !== undefined;

/* The tool each level's instruction tells the agent to CALL: a different
 * question from what the level NEEDS. The engine asks "can this session do the
 * thing I am about to tell it to do", and there the exact tool named matters. */
export const REPLY_LEVEL_TOOLS: Record<number, string[]> = {
  1: ["chat"],
  2: ["chat"],
  3: ["chat", "speak"],
  4: ["speak"],
  5: ["speak"],
};

/* THE VERBOSITY NAMES, the word on the slider rail and in the placeholder. HIS
 * REVIEWED WORDING (WORDING-VERBOSITY-FINAL.txt, 2026-08-16): rung 5 is "Voice
 * only" now. */
export const DEFAULT_REPLY_NAMES: Record<number, string> = {
  1: "Terminal",
  2: "Chat",
  3: "Read out",
  4: "Spoken",
  5: "Voice only",
};

/* THE VERBOSITY STRING appended for each rung. Raw, with the leading space that
 * joins it to the message (the engine appends it straight on, no separator). HIS
 * REVIEWED WORDING (WORDING-VERBOSITY-FINAL.txt, 2026-08-16): rung 1 simplified,
 * rung 2 dropped the do-not-speak clause, rung 3 rephrased to name both tools,
 * rungs 4/5 unchanged. */
export const DEFAULT_REPLY_TEXT: Record<number, string> = {
  1: " (Reply with a copy of your terminal output via the chat tool. Send the" +
     " same detail you would print in the terminal.)",
  2: " (Reply with the chat tool, the way you would message someone. complete" +
     " but not exhaustive, structured where structure helps, a few short" +
     " paragraphs at most.)",
  3: " (Reply with the chat tool AND the speak tool. Send a short spoken summary" +
     " of the reply via speak tool and a full text message via chat tool.)",
  4: " (Answer with the speak tool. The spoken answer must stand on its own:" +
     " concise, complete, whole sentences, no markdown, no paths read aloud." +
     " Use the chat tool only for what speech cannot carry, when it is needed:" +
     " code, tables, diffs, file paths, long lists.)",
  5: " (Answer with the speak tool only: concise, complete, whole sentences, no" +
     " markdown. Do not send a chat message.)",
};

/* THE COMPLEXITY NAMES. HIS REVIEWED WORDING (WORDING-COMPLEXITY-FINAL.txt,
 * 2026-08-16): 2 is "Junior Developer", 4 "Multitasking Developer", 5 "Focused
 * Developer"; 1 and 3 keep their names. */
export const DEFAULT_COMPLEXITY_NAMES: Record<number, string> = {
  1: "Product Manager",
  2: "Junior Developer",
  3: "Short and Simple",
  4: "Multitasking Developer",
  5: "Focused Developer",
};

/* THE COMPLEXITY STRING appended for each rung. Raw, leading space included (the
 * engine appends it straight on). HIS REVIEWED WORDING (WORDING-COMPLEXITY-FINAL.txt,
 * 2026-08-16): all five rephrased around the reviewed names. */
export const DEFAULT_COMPLEXITY_TEXT: Record<number, string> = {
  1: " (Pitch this at a product manager: lead with what it means and what it" +
     " changes, in plain language. Where a technical word is the only accurate" +
     " one, use it and say what it means.)",
  2: " (Pitch this at a junior developer who is learning the craft. Lead with" +
     " what it means and what it changes, avoid assuming heavy technical jargon" +
     " knowledge.)",
  3: " (Keep this super short and simple: the context, the answer, the reason," +
     " the question and nothing extra worth knowing.)",
  4: " (Pitch this at a working developer juggling multiple agents: lead with" +
     " the context and assume the basics are known.)",
  5: " (Pitch this at a developer who is solely focused on this agent only. Full" +
     " technical depth, the tradeoffs you considered, the edge cases.)",
};

/* THE PROMPT BITS, a plain list of strings (#465). HIS FINAL REVIEWED LIST
 * (WORDING-BITS-FINAL.txt, 2026-08-16): seven bits replacing the old sixteen
 * verbatim, ORDER as given (order is what the menu shows). Review closed. */
export const DEFAULT_PROMPT_BITS: string[] = [
  "short answer",
  "discuss. don't do.",
  "add to task list, don't discuss or do.",
  "do in a background agent.",
  "explain with examples.",
  "Answer with a md file with the show tool.",
  "Show an interactive HTML page with the show tool.",
];

/* Where each dial starts before anyone touches it: 3 (read out) and 3 (short and
 * simple), the rungs defensible before anyone has said anything about themselves. */
export const DEFAULT_REPLY_LEVEL = 3;
export const DEFAULT_COMPLEXITY = 3;

/* THE SLIDER STEP HINT, from the appended string itself (#595/#598). The hint the
 * composer draws under a rung IS that rung's appended text, cleaned for display:
 * the wire's leading space and the wrapping parens stripped. It is display cleanup
 * ONLY, never a separate invented line, so the hint can never drift from what the
 * engine actually appends. Exported as the ONE source both composerWidgets() and
 * the test derive the hint from (a literal copy in either would be exactly the
 * drift #598 came to kill). */
export function stepHint(appendedText: string): string {
  const t = appendedText.trim();
  return t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1).trim() : t;
}

/* ---- the state shape ------------------------------------------------------- */

type RungOverride = { name?: string; text?: string };
export type ReplyStringOverrides = {
  reply?: Record<number, RungOverride>;
  complexity?: Record<number, RungOverride>;
  bits?: string[];
};

export type DialsState = {
  level: number;
  complexity: number;
  verbosityOn: boolean;
  complexityOn: boolean;
  promptBitsOn: boolean;
  overrides: ReplyStringOverrides;
};

/* What ASK returns: the level in force (after channel bending), the complexity
 * dial, and what the engine appends to a message. No `needs` any more: the Stop
 * hook is verbosity-unaware, so a delivery carries no channel demand. */
export type ReplyAsk = {
  level: number;
  complexity: number;
  instruction: string;
};

/* A migration ran and this is what it found, count-logged so a silent drop is
 * impossible. */
export type MigrationReport = {
  from: "reply-dials.json" | "reply-levels.json" | "none";
  level: number;
  complexity: number;
  textOverrides: { reply: number; complexity: number };
  migrated: boolean; // came out of the old per-session map, unadopted
};

const DIALS_FILE = "reply-dials.json";

/* ---- pure migration off the legacy reply-levels.json ----------------------- */

/* Read the old file, in both shapes it could have, into a partial DialsState plus
 * a count-report. NEW shape {level, complexity, append, strings}; OLD shape a map
 * of pane id -> level (majority vote, ties to the higher rung). Overrides are set
 * SPARSELY: only a stored string that DIFFERS from the compiled default becomes an
 * override. Toggles come from `append` (verbosityOn = complexityOn = append); the
 * app server's real toggle values arrive later in the import step and overwrite.
 * promptBitsOn defaults on (the old file never carried it). */
export function migrateLegacyLevels(json: unknown): { state: Partial<DialsState>; report: MigrationReport } {
  const report: MigrationReport = {
    from: "reply-levels.json", level: DEFAULT_REPLY_LEVEL, complexity: DEFAULT_COMPLEXITY,
    textOverrides: { reply: 0, complexity: 0 }, migrated: false,
  };
  const state: Partial<DialsState> = { promptBitsOn: true };
  if (!json || typeof json !== "object") return { state, report };
  const j = json as Record<string, unknown>;

  // the edited wording rides in the same file; keep only the rungs that differ
  const overrides: ReplyStringOverrides = {};
  const strings = j.strings as { reply?: unknown; complexity?: unknown } | undefined;
  if (strings && typeof strings === "object") {
    const reply: Record<number, RungOverride> = {};
    const complexity: Record<number, RungOverride> = {};
    const take = (src: unknown, into: Record<number, RungOverride>, def: Record<number, string>) => {
      if (!src || typeof src !== "object") return 0;
      let n = 0;
      for (const rung of RUNGS) {
        const v = (src as Record<string, unknown>)[rung];
        if (typeof v === "string" && v !== (def[rung] ?? "")) { into[rung] = { text: v }; n++; }
      }
      return n;
    };
    report.textOverrides.reply = take(strings.reply, reply, DEFAULT_REPLY_TEXT);
    report.textOverrides.complexity = take(strings.complexity, complexity, DEFAULT_COMPLEXITY_TEXT);
    if (Object.keys(reply).length) overrides.reply = reply;
    if (Object.keys(complexity).length) overrides.complexity = complexity;
  }
  if (overrides.reply || overrides.complexity) state.overrides = overrides;

  if (validRung(j.level)) {
    // NEW shape: read as-is, no migration handshake
    state.level = j.level;
    report.level = j.level;
    if (typeof j.complexity === "number" && DEFAULT_COMPLEXITY_NAMES[j.complexity]) {
      state.complexity = j.complexity;
      report.complexity = j.complexity;
    }
    const append = j.append !== false; // absent = on
    state.verbosityOn = append;
    state.complexityOn = append;
    report.migrated = false;
  } else {
    // OLD pane-map: majority vote for the one level, ties to the higher rung
    const votes = new Map<number, number>();
    for (const v of Object.values(j)) {
      if (validRung(v)) votes.set(v, (votes.get(v) ?? 0) + 1);
    }
    let best = DEFAULT_REPLY_LEVEL, bestN = 0;
    for (const [lvl, n] of votes) if (n > bestN || (n === bestN && lvl > best)) { best = lvl; bestN = n; }
    if (bestN) {
      state.level = best;
      report.level = best;
      report.migrated = true;
    }
    // an old file with no append switch appended, so both dials start on
    state.verbosityOn = true;
    state.complexityOn = true;
  }
  return { state, report };
}

/* ---- the store ------------------------------------------------------------- */

/* SHIP DEFAULTS (his call, 2026-08-16): the prompt bits and the verbosity slider
 * ship ENABLED; the complexity slider ships DISABLED (present, off, enabled by
 * talking to the agent or the `toggle` op). So a fresh engine's composer shows
 * two widgets, not three. Migration keeps an old engine's own toggles (an old
 * file with append on turns both dials on); this is only the cold-start default. */
export function defaultState(): DialsState {
  return {
    level: DEFAULT_REPLY_LEVEL,
    complexity: DEFAULT_COMPLEXITY,
    verbosityOn: true,
    complexityOn: false,
    promptBitsOn: true,
    overrides: {},
  };
}

export class ReplyDialsStore {
  private s: DialsState = defaultState();
  /* the migration handshake flag, kept alive as a thin shim for the deployed old
   * app's connect-adopt; it dies with the routes when they are removed. */
  private migrated = false;
  private readonly dialsPath: string;
  /* set by server.ts: redeclare the plugins, rewrite the hook state, rebroadcast
   * the sessions frame. Called after every mutation. */
  onChange: (() => void) | null = null;

  constructor(dataDir: string) {
    const dir = dataDir.endsWith("/") ? dataDir : dataDir + "/";
    this.dialsPath = dir + DIALS_FILE;
  }

  /* Read reply-dials.json if it exists; defaults otherwise. The engine carries
   * no migration code (the design): a legacy reply-levels.json is simply not
   * read. migrateLegacyLevels stays exported as the pure translation a hand
   * migration can use. */
  async load(): Promise<MigrationReport | null> {
    try {
      const j = (await Bun.file(this.dialsPath).json()) as Record<string, unknown> | null;
      if (j && typeof j === "object") {
        this.s = this.coerce(j);
        this.migrated = j.migrated === true;
      }
    } catch { /* not present: defaults stand */ }
    return null;
  }

  /* Coerce a stored blob into a valid DialsState, dropping anything malformed. */
  private coerce(j: Record<string, unknown>): DialsState {
    const out = defaultState();
    if (validRung(j.level)) out.level = j.level;
    if (typeof j.complexity === "number" && DEFAULT_COMPLEXITY_NAMES[j.complexity]) out.complexity = j.complexity;
    if (typeof j.verbosityOn === "boolean") out.verbosityOn = j.verbosityOn;
    if (typeof j.complexityOn === "boolean") out.complexityOn = j.complexityOn;
    if (typeof j.promptBitsOn === "boolean") out.promptBitsOn = j.promptBitsOn;
    out.overrides = this.coerceOverrides(j.overrides);
    return out;
  }

  private coerceOverrides(v: unknown): ReplyStringOverrides {
    const out: ReplyStringOverrides = {};
    if (!v || typeof v !== "object") return out;
    const o = v as Record<string, unknown>;
    const takeRungs = (src: unknown): Record<number, RungOverride> | undefined => {
      if (!src || typeof src !== "object") return undefined;
      const into: Record<number, RungOverride> = {};
      for (const rung of RUNGS) {
        const e = (src as Record<string, unknown>)[rung];
        if (!e || typeof e !== "object") continue;
        const entry: RungOverride = {};
        const { name, text } = e as Record<string, unknown>;
        if (typeof name === "string") entry.name = name;
        if (typeof text === "string") entry.text = text;
        if (Object.keys(entry).length) into[rung] = entry;
      }
      return Object.keys(into).length ? into : undefined;
    };
    const reply = takeRungs(o.reply);
    const complexity = takeRungs(o.complexity);
    if (reply) out.reply = reply;
    if (complexity) out.complexity = complexity;
    if (Array.isArray(o.bits)) out.bits = o.bits.filter((x): x is string => typeof x === "string");
    return out;
  }

  /* The single writer. The dir is made per write: the plugin data dir may not
   * exist yet on a fresh engine. */
  async save(): Promise<void> {
    const body = { v: 1, ...this.s, migrated: this.migrated };
    const dir = this.dialsPath.slice(0, this.dialsPath.lastIndexOf("/"));
    await mkdirPrivate(dir).catch(() => {});
    await writePrivate(this.dialsPath, JSON.stringify(body)).catch((e: unknown) =>
      console.error("[reply-dials] could not persist:", e));
  }

  // ---- reads ----
  state(): DialsState { return this.s; }
  level(): number { return this.s.level; }
  complexity(): number { return this.s.complexity; }
  isMigrated(): boolean { return this.migrated; }
  verbosityName(n: number): string { return this.s.overrides.reply?.[n]?.name ?? DEFAULT_REPLY_NAMES[n] ?? ""; }
  verbosityText(n: number): string { return this.s.overrides.reply?.[n]?.text ?? DEFAULT_REPLY_TEXT[n] ?? ""; }
  complexityName(n: number): string { return this.s.overrides.complexity?.[n]?.name ?? DEFAULT_COMPLEXITY_NAMES[n] ?? ""; }
  complexityText(n: number): string { return this.s.overrides.complexity?.[n]?.text ?? DEFAULT_COMPLEXITY_TEXT[n] ?? ""; }
  bits(): string[] { return this.s.overrides.bits ?? DEFAULT_PROMPT_BITS; }

  /* What to ASK this session for: its level, unless its MCP cannot honour that
   * level, in which case the nearest level it can. Per-dial gating: the
   * verbosity string is gated on verbosityOn, the complexity string on
   * complexityOn. Channel bending is unchanged. A pure input transform (a soft
   * nudge): nothing here is enforced, and no channel demand travels to the
   * Stop hook. */
  askFor(channels: string[]): ReplyAsk {
    const ask = (level: number): ReplyAsk => ({
      level,
      complexity: this.s.complexity,
      // verbosityText(0) is "" (there is no rung 0), so a session with no channel
      // at all appends only the complexity half, or nothing if that is off too
      instruction:
        (this.s.verbosityOn ? this.verbosityText(level) : "") +
        (this.s.complexityOn ? this.complexityText(this.s.complexity) : ""),
    });
    const want = this.s.level;
    const own = validRung(want) ? want : DEFAULT_REPLY_LEVEL;
    if (!channels.length) return ask(own); // did not say; never guess
    const have = new Set(channels);
    if ((REPLY_LEVEL_TOOLS[own] ?? []).every((t) => have.has(t))) return ask(own);
    // the nearest end it can reach: spoken if it can speak, written if it can
    // write, and no channel at all (level 0) if it can do neither
    const alt = have.has("speak") ? 5 : have.has("chat") ? 2 : 0;
    console.log(`[reply-dials] cannot honour level ${own} with [${channels.join(" ")}]` +
      `${alt ? `; asking for level ${alt} instead` : "; no channel to ask for"}`);
    return ask(alt);
  }

  // ---- mutations (each validates, saves, then onChange) ----
  private async commit(): Promise<void> {
    await this.save();
    this.onChange?.();
  }

  async setLevel(n: number): Promise<boolean> {
    if (!validRung(n)) return false;
    this.s.level = n;
    this.migrated = false; // stating a level ends the migration (the shim)
    await this.commit();
    return true;
  }

  async setComplexity(n: number): Promise<boolean> {
    if (!DEFAULT_COMPLEXITY_NAMES[n]) return false;
    this.s.complexity = n;
    // a complexity-only change leaves the migration flag alone
    await this.commit();
    return true;
  }

  async setToggles(patch: { verbosityOn?: unknown; complexityOn?: unknown; promptBitsOn?: unknown }): Promise<void> {
    if (typeof patch.verbosityOn === "boolean") this.s.verbosityOn = patch.verbosityOn;
    if (typeof patch.complexityOn === "boolean") this.s.complexityOn = patch.complexityOn;
    if (typeof patch.promptBitsOn === "boolean") this.s.promptBitsOn = patch.promptBitsOn;
    await this.commit();
  }

  /* Set or clear wording overrides. `null` clears one override back to the
   * compiled default; a string sets it raw (leading space kept). */
  async setWording(patch: {
    reply?: Record<number, { name?: string | null; text?: string | null }>;
    complexity?: Record<number, { name?: string | null; text?: string | null }>;
  }): Promise<void> {
    const apply = (
      src: Record<number, { name?: string | null; text?: string | null }> | undefined,
      key: "reply" | "complexity",
    ) => {
      if (!src) return;
      const bag = (this.s.overrides[key] ??= {});
      for (const rung of RUNGS) {
        const e = src[rung];
        if (!e || typeof e !== "object") continue;
        const cur = (bag[rung] ??= {});
        if ("name" in e) { if (e.name == null) delete cur.name; else if (typeof e.name === "string") cur.name = e.name; }
        if ("text" in e) { if (e.text == null) delete cur.text; else if (typeof e.text === "string") cur.text = e.text; }
        if (!Object.keys(cur).length) delete bag[rung];
      }
      if (!Object.keys(bag).length) delete this.s.overrides[key];
    };
    apply(patch.reply, "reply");
    apply(patch.complexity, "complexity");
    await this.commit();
  }

  async resetWording(which: "reply" | "complexity" | "all"): Promise<void> {
    if (which === "reply" || which === "all") delete this.s.overrides.reply;
    if (which === "complexity" || which === "all") delete this.s.overrides.complexity;
    await this.commit();
  }

  /* Replace the bit list wholesale. Refuses over-cap, over-long or empty items,
   * naming the cap, so the widget the decl builds can never be dropped by the
   * validator downstream. */
  setBitsValidate(list: unknown): string | null {
    if (!Array.isArray(list)) return "bits must be a list of strings";
    if (list.length > MENU_MAX_ITEMS) return `too many bits: ${list.length} > ${MENU_MAX_ITEMS}`;
    for (const b of list) {
      if (typeof b !== "string" || !b) return "a bit is empty or not a string";
      if (b.length > MENU_ITEM_TEXT_MAX) return `a bit is too long: ${b.length} > ${MENU_ITEM_TEXT_MAX} chars`;
    }
    return null;
  }

  async setBits(list: string[]): Promise<void> {
    this.s.overrides.bits = list.slice();
    await this.commit();
  }

  async resetBits(): Promise<void> {
    delete this.s.overrides.bits;
    await this.commit();
  }

  /* One-shot import from the app-server bag (2.5b). Names and texts become
   * overrides only where they DIFFER from the compiled defaults; bits replace the
   * list (over-cap items dropped and counted); toggles copied. Idempotent. */
  async importFromApp(bag: {
    strings?: { reply?: unknown; complexity?: unknown; bits?: unknown };
    verbosityOn?: unknown;
    complexityOn?: unknown;
    promptBitsOn?: unknown;
  }): Promise<{ imported: { names: number; texts: number; bits: number; toggles: number }; dropped: { bits: number } }> {
    let names = 0, texts = 0, toggles = 0, bitsCount = 0, bitsDropped = 0;
    const strings = bag.strings ?? {};

    const importRungs = (
      src: unknown,
      key: "reply" | "complexity",
      defName: Record<number, string>,
      defText: Record<number, string>,
    ) => {
      if (!src || typeof src !== "object") return;
      const bag2 = (this.s.overrides[key] ??= {});
      for (const rung of RUNGS) {
        const e = (src as Record<string, unknown>)[rung];
        if (!e || typeof e !== "object") continue;
        const { name, text } = e as Record<string, unknown>;
        const cur = (bag2[rung] ??= {});
        if (typeof name === "string" && name !== (defName[rung] ?? "")) { cur.name = name; names++; }
        if (typeof text === "string" && text !== (defText[rung] ?? "")) { cur.text = text; texts++; }
        if (!Object.keys(cur).length) delete bag2[rung];
      }
      if (!Object.keys(bag2).length) delete this.s.overrides[key];
    };
    importRungs(strings.reply, "reply", DEFAULT_REPLY_NAMES, DEFAULT_REPLY_TEXT);
    importRungs(strings.complexity, "complexity", DEFAULT_COMPLEXITY_NAMES, DEFAULT_COMPLEXITY_TEXT);

    if (Array.isArray(strings.bits)) {
      const kept: string[] = [];
      for (const b of strings.bits) {
        if (typeof b === "string" && b && b.length <= MENU_ITEM_TEXT_MAX && kept.length < MENU_MAX_ITEMS) kept.push(b);
        else bitsDropped++;
      }
      this.s.overrides.bits = kept;
      bitsCount = kept.length;
    }

    for (const [k, v] of Object.entries({ verbosityOn: bag.verbosityOn, complexityOn: bag.complexityOn, promptBitsOn: bag.promptBitsOn })) {
      if (typeof v === "boolean") { (this.s as any)[k] = v; toggles++; }
    }

    await this.commit();
    return { imported: { names, texts, bits: bitsCount, toggles }, dropped: { bits: bitsDropped } };
  }

  /* The composer widgets, built LIVE from state. Order = today's pill order:
   * bits, then the two dials. Each slider carries its current `value` so the app
   * draws the rail from the decl alone, no state fetch.
   *
   * EACH SLIDER STEP CARRIES A `hint` (#595): the rung's appended text, so the
   * app draws the current rung's DESCRIPTION under the rail and not just its
   * name -- the native dial always explained the step, and the plugin slider
   * must too. `stepHint` is display cleanup only (strip the leading space and the
   * wrapping parens the wire text is stored with); the wording is his reviewed
   * appended text, never a separate invented line. The hint is derived LIVE from
   * verbosityText/complexityText (the same strings askFor appends), so an app
   * wording edit that lands via setWording flows straight into the redeclared
   * decl -- no static table to drift (#598). The app clamps the display to two
   * lines and keeps the full text on the stop's hover title.
   *
   * DISTINCT GLYPHS (#595/#598): the three controls must not read as one. The
   * prompt-bits menu wears `edit` (the pencil, its own glyph, #598); verbosity
   * keeps `equalizer` (the native dial's own equalizer-style glyph); complexity
   * moves off `group` (a people cluster that, small, was a near-twin of the
   * equalizer's dots) to `statistics` (ascending bars, a level/depth read). All
   * three are registered app glyphs (lib/tablerIcons.ts). */
  composerWidgets(): ComposerWidgetDecl[] {
    const out: ComposerWidgetDecl[] = [];
    const bits = this.bits();
    if (this.s.promptBitsOn && bits.length) {
      out.push({ type: "menu", key: "bits", icon: "edit", label: "Prompt bits",
        items: bits.map((b) => ({ text: b, insert: b })) });
    }
    if (this.s.verbosityOn) {
      out.push({ type: "slider", key: "verbosity", icon: "equalizer", label: "Verbosity",
        value: this.s.level,
        steps: RUNGS.map((n) => ({ n, name: this.verbosityName(n), hint: stepHint(this.verbosityText(n)) })) });
    }
    if (this.s.complexityOn) {
      out.push({ type: "slider", key: "complexity", icon: "statistics", label: "Complexity",
        value: this.s.complexity,
        steps: RUNGS.map((n) => ({ n, name: this.complexityName(n), hint: stepHint(this.complexityText(n)) })) });
    }
    return out;
  }
}

/* ---- the plugin spec ------------------------------------------------------- */

/* The plugin's bag is just its own store now (ONE replyDialsStore
 * built at the root, used by server.ts for the replyLevel shim AND here). The
 * old `sessionExists` half was dead -- every rpc op is engine-global and ignores
 * the session -- so it is gone.
 *
 * THE DELIVERY-TIME APPEND IS THE PLUGIN'S OWN NOW. The instruction append is a
 * core.inputTransform hook the plugin registers when it loads (below), over its
 * own store: a plugin owns its input transform, and core folds every registered
 * transform at the one delivery site (deliver.ts). It used to be registered at
 * the composition root (server.ts) so the delivery seam tests, which do not load
 * the plugins layer, still got the append for free; those tests now wire the
 * transform themselves. An engine that does not load this plugin appends nothing,
 * which is the correct #590 behavior, not a regression. */
export type DialsDeps = { store: ReplyDialsStore };

/* THE STORE IS THE PLUGIN'S OWN (blueprint section 3, the sanctioned partial):
 * constructed and loaded here, awaited once by the composition root, which
 * then hands the loaded instance to the plugin wiring and to the dials seam.
 * Core builds nothing. */
let storeSingleton: ReplyDialsStore | null = null;
export async function replyDialsStore(): Promise<ReplyDialsStore> {
  if (!storeSingleton) {
    storeSingleton = new ReplyDialsStore(pluginDataDir("reply-dials"));
    await storeSingleton.load();
  }
  return storeSingleton;
}

/** TEST ONLY: drop the loaded store, so the next replyDialsStore() builds one
 *  against whatever the data dir is NOW. The dir is baked into the instance at
 *  construction, so an in-process seam wiring that re-wires into a second tmp
 *  data dir would otherwise keep writing dial changes into the first one's.
 *  No-op in production, which builds the store once at boot and never again. */
export function resetForTest(): void {
  storeSingleton = null;
}

/* A 400-shaped error the rpc route turns into an HTTP 400. */
class RpcError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/* The wire ops (2.2). Each reaches the engine over /plugin/reply-dials/rpc/<op>
 * with body {session?, args}; session is ignored (the state is engine-global).
 *
 * Agent-callable, e.g.:
 *   curl -sX POST http://127.0.0.1:10101/plugin/reply-dials/rpc/set \
 *     -H 'content-type: application/json' -d '{"args":{"key":"verbosity","n":4}}'
 */
export function replyDialsPlugin(deps: DialsDeps, core?: (id: string) => PluginCore): PluginSpec {
  const store = deps.store;

  /* THE PLUGIN REGISTERS ITS OWN DELIVERY-TIME APPEND when it loads: a postfix
   * input-transform hook that returns the store's `askFor(channels).instruction`,
   * byte-identical to the old root registration. Core folds every registered
   * transform at the one delivery site, so multiple plugins' transforms nest.
   * A bare loadPlugins() with no core (a test) registers nothing and appends
   * nothing, which is the correct behavior for an engine without the plugin. */
  core?.("reply-dials").inputTransform((input) =>
    ({ postfix: store.askFor(input.channels).instruction }));

  const asObj = (args: unknown): Record<string, unknown> =>
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  const effectiveWording = () => {
    const rung = (name: (n: number) => string, text: (n: number) => string,
      defName: Record<number, string>, defText: Record<number, string>) => {
      const out: Record<number, { name: string; text: string; edited: { name: boolean; text: boolean } }> = {};
      for (const n of RUNGS) {
        out[n] = { name: name(n), text: text(n),
          edited: { name: name(n) !== (defName[n] ?? ""), text: text(n) !== (defText[n] ?? "") } };
      }
      return out;
    };
    return {
      verbosity: rung((n) => store.verbosityName(n), (n) => store.verbosityText(n), DEFAULT_REPLY_NAMES, DEFAULT_REPLY_TEXT),
      complexity_rungs: rung((n) => store.complexityName(n), (n) => store.complexityText(n), DEFAULT_COMPLEXITY_NAMES, DEFAULT_COMPLEXITY_TEXT),
    };
  };

  const rpc: Record<string, (ctx: RpcCtx, args: unknown) => Promise<unknown>> = {
    get: async () => {
      const s = store.state();
      const w = effectiveWording();
      return {
        level: s.level, complexity: s.complexity, migrated: store.isMigrated(),
        verbosityOn: s.verbosityOn, complexityOn: s.complexityOn, promptBitsOn: s.promptBitsOn,
        verbosity: w.verbosity, complexity_rungs: w.complexity_rungs,
        bits: store.bits(),
        defaults: { names: DEFAULT_REPLY_NAMES, texts: DEFAULT_REPLY_TEXT, bits: DEFAULT_PROMPT_BITS,
          complexityNames: DEFAULT_COMPLEXITY_NAMES, complexityTexts: DEFAULT_COMPLEXITY_TEXT },
      };
    },

    set: async (_s, args) => {
      const a = asObj(args);
      const n = Number(a.n);
      if (a.key === "verbosity") {
        if (!(await store.setLevel(n))) throw new RpcError(`unknown verbosity rung: ${a.n}`);
      } else if (a.key === "complexity") {
        if (!(await store.setComplexity(n))) throw new RpcError(`unknown complexity rung: ${a.n}`);
      } else {
        throw new RpcError(`unknown dial key: ${JSON.stringify(a.key)} (want "verbosity" or "complexity")`);
      }
      return { level: store.level(), complexity: store.complexity() };
    },

    toggle: async (_s, args) => {
      const a = asObj(args);
      await store.setToggles(a);
      const s = store.state();
      return { verbosityOn: s.verbosityOn, complexityOn: s.complexityOn, promptBitsOn: s.promptBitsOn };
    },

    wording: async (_s, args) => {
      const a = asObj(args);
      if (a.reset === "reply" || a.reset === "complexity" || a.reset === "all") {
        await store.resetWording(a.reset);
      }
      const reply = a.reply as Record<number, { name?: string | null; text?: string | null }> | undefined;
      const complexity = a.complexity as Record<number, { name?: string | null; text?: string | null }> | undefined;
      if (reply || complexity) await store.setWording({ reply, complexity });
      return effectiveWording();
    },

    bits: async (_s, args) => {
      const a = asObj(args);
      if (a.reset === true) { await store.resetBits(); return { bits: store.bits() }; }
      const err = store.setBitsValidate(a.bits);
      if (err) throw new RpcError(err);
      await store.setBits(a.bits as string[]);
      return { bits: store.bits() };
    },

    import: async (_s, args) => {
      const a = asObj(args);
      return store.importFromApp(a as Parameters<ReplyDialsStore["importFromApp"]>[0]);
    },
  };

  return {
    id: "reply-dials",
    name: "Reply dials",
    version: 1,
    composer: () => store.composerWidgets(),
    rpc,
  };
}

/* Re-exported so the rpc route can map an RpcError to its status without importing
 * the class name from two files. */
export function rpcErrorStatus(e: unknown): number | null {
  return e instanceof RpcError ? e.status : null;
}
