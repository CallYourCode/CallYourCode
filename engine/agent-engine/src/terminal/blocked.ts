/* WHAT A SESSION IS WAITING FOR, read off its screen.
 *
 * herdr tells us a pane is `blocked`. It does not tell us what the question is,
 * because it never reads one: its whole claude integration
 * (~/.claude/hooks/herdr-agent-state.sh, v7) only reports the session id. The
 * status itself comes from a SCREEN-SCRAPING rule manifest
 * (~/.local/state/herdr/agent-detection/remote/claude.toml), which is worth
 * knowing because it decides exactly what `blocked` can and cannot mean.
 *
 * MEASURED, on a live pane (herdr 0.7.4, Claude Code v2.1.220), 2026-08-04.
 * Every rule in that manifest whose state is `blocked` fires on the same thing:
 * a MODAL LIST OF NUMBERED CHOICES is on screen. Four shapes were reproduced:
 *
 *   - a tool permission prompt      "Do you want to create note.txt?"  1/2/3
 *     (rule legacy_no_prompt_blocker)
 *   - a bash permission prompt      "Do you want to proceed?"          1/2/3
 *     (rule generic_permission_prompt)
 *   - an AskUserQuestion form       "Which colour do you prefer?"      1..5
 *     (rule live_blocked_form)
 *   - a plan approval               "...Would you like to proceed?"    1..4
 *     (rule legacy_no_prompt_blocker)
 *
 * AND WHAT IT CANNOT MEAN. A question asked in PROSE, at the end of a reply
 * ("let me know if you want me to retry it or skip it"), leaves the pane idle
 * or done: the turn ended, the input box came back, nothing is modal. herdr
 * reports it as finished and so do we. That is not a gap this file can close by
 * parsing harder -- there is no signal to parse -- and the app already has a way
 * to answer it, which is to type a reply like any other message.
 *
 * So: one shape, honestly. A question, some context, and a numbered list. If
 * this parser cannot find that shape on a screen herdr called blocked, the
 * answer is `null` and the app is told the session is waiting on SOMETHING it
 * cannot show, rather than being handed a confident guess. That distinction is
 * the whole point (the app-asserting-what-it-does-not-know note).
 */

/** One choice in the list, exactly as the terminal numbers it. */
export type AskChoice = {
  n: number; // the digit you would press
  label: string; // "Yes", "No, refine with...", "Type something."
  detail?: string; // the indented line under it, when there is one
  /* THIS CHOICE OPENS A TEXT FIELD INSTEAD OF ACTING, AND WE CANNOT FINISH IT.
   *
   * Flagged so the app can show it as what it is rather than as a button that
   * silently does nothing. Nothing presses it: see the note below.
   *
   * MEASURED, on a live plan-approval dialog, and the measurements did not
   * agree with each other, which is why this is a refusal rather than a
   * feature. Pressing "4" selects the field and typing replaces the label, both
   * reliably. Submitting it is the part that will not settle: one run took
   * shift+tab then enter and the agent re-planned; a second run of the same
   * three steps with enter alone left the dialog exactly where it was; a third,
   * with shift+tab alone, changed nothing at all. The hint the terminal prints
   * under it ("shift+tab to approve with this feedback") describes APPROVING
   * THE PLAN with the feedback attached, which is the permissive direction and
   * not what tapping "tell Claude what to change" should ever do.
   *
   * Three readings of one question means the question is wrong, so this build
   * does not answer these from the app. It says so instead. */
  freeText?: boolean;
};

export type Ask = {
  question: string; // the question, unwrapped onto one line
  context: string[]; // what it is asking ABOUT: the command, the file, the plan
  choices: AskChoice[];
  /* Identifies THIS DECISION -- question, context AND choices, see
   * fingerprintOf. An answer carries it back and the engine re-reads the screen
   * before pressing anything: a fingerprint that no longer matches means the
   * session moved on, and the keystroke is refused rather than landing on
   * whatever is there now. */
  fingerprint: string;
};

// A choice line: optional selection caret, a number, a dot, the label.
const CHOICE_RE = /^\s*(?:[❯>]\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
/* Two kinds of horizontal rule, and they mean different things.
 *
 * SOLID is the dialog's own edge: the top of the permission box, the border of
 * the prompt box. DASHED is a separator INSIDE a detail block -- the file
 * preview in a write prompt is fenced with them, and so is the plan body. So a
 * solid rule bounds the context and a dashed one does not, which is the
 * difference between showing "Create file / note.txt / 1 banana" and showing
 * one orphan line of diff. */
const SOLID_RULE_RE = /^\s*[─━═▔▁_-]{6,}\s*$/;
const DASH_RULE_RE = /^\s*[╌┄┈]{6,}\s*$/;
/* THE VIEWPORT RULE, which is a third thing again: the line claude draws
 * between the transcript and whatever occupies the bottom of the screen. It is
 * the only rule on the /model picker, and on the plan approval it sits ABOVE
 * that dialog's own solid top edge. Used by the context walk, which must never
 * cross it -- see the note there. Still a rule everywhere else, so it is
 * matched by SOLID_RULE_RE too and this narrows rather than replaces. */
const VIEWPORT_RULE_RE = /^\s*▔{6,}\s*$/;
const isRule = (line: string) => SOLID_RULE_RE.test(line) || DASH_RULE_RE.test(line);
/* The footer the terminal prints under a dialog. Not content, and not a reason
 * to stop scanning.
 *
 * "TO ADJUST" IS THE /model PICKER'S, and it is the row that made this parser
 * answer null on a dialog it can otherwise read completely. Between the last
 * model and the footer, Claude Code draws a CONTROL:
 *
 *   ● High effort (default) ←/→ to adjust
 *
 * A content line below the last choice disqualifies the whole screen -- that is
 * the guard that stops an ordinary turn ending in a numbered list from being
 * read as buttons -- so the picker parsed as nothing at all, classified
 * `unknown`, and the app told him it could not read a screen it had read fine.
 *
 * It belongs here rather than anywhere else because it is the same THING as the
 * lines already in this list: a row that names a key and what pressing it does.
 * "←/→ to adjust" is "↑/↓ to navigate" for a different pair of arrows, and that
 * one has always been a hint. Captured at 60, 100 and 200 columns off Claude
 * Code 2.1.222 (fixtures/pane-model-picker-2.1.222*.txt): the row is on every
 * one of them, in the same place, and it is the only thing between the choices
 * and the footer. */
const HINT_RE =
  /(esc to (cancel|close)|enter to select|to navigate|to amend|ctrl\+[a-z]|shift\+tab|to explain|to edit|to approve|to toggle|to set as default|to adjust)/i;

/* Labels that mean "this one lets you write instead of choose".
 *
 * A whitelist rather than a guess, because getting it wrong in the other
 * direction types a sentence into a dialog that wanted a keypress. Every entry
 * was seen on a real screen. */
const FREE_TEXT_RE =
  /^(type something|tell claude what to change|no, tell claude|write .*instead|other|custom)/i;

/* IDENTIFIES ONE DECISION, AND IT MUST COVER THE PART THAT SAYS WHICH ONE.
 *
 * THE CONTEXT IS IN HERE, and leaving it out was a bug that pressed Yes on the
 * wrong file. On a Write prompt the filename is in the question ("Do you want
 * to create note.txt?"), which is what made the omission look harmless. On a
 * READ prompt it is not:
 *
 *     Read file
 *      Read(/tmp/x/alpha.txt)      <- context: the ONLY distinguishing line
 *     Do you want to proceed?      <- identical for every file
 *      1. Yes
 *      2. Yes, allow reading from x/ during this session
 *      3. No
 *
 * Two files in one directory gave a byte-identical question and byte-identical
 * choices, so the fingerprints matched, so an answer drawn for alpha.txt was
 * pressed against beta.txt -- and because the status never left `blocked` and
 * the dialog then dismissed, the after-check passed and it reported success.
 * Bash is the same shape and worse: the question is always "Do you want to
 * proceed?", the command lives in the context, and choice 2 can be "and don't
 * ask again for rm commands in <cwd>", which two different rm invocations in
 * one directory share exactly.
 *
 * So: hash EVERYTHING that distinguishes one decision from another. The two
 * things deliberately left out are the selection caret and the per-choice
 * descriptions, because neither changes what a choice DOES; arrowing down in
 * the terminal must not invalidate an answer already in flight.
 *
 * The separators are control characters so that a filename containing one
 * cannot forge another record's basis, and they are written as ESCAPES: the
 * literal bytes made git treat this file as binary, which cost the diff.
 */
function fingerprintOf(question: string, context: string[], choices: AskChoice[]): string {
  const basis = [
    question,
    context.map((l) => l.trim()).join("\x02"),
    choices.map((c) => `${c.n}:${c.label}`).join("\x01"),
  ].join("\x00");
  // FNV-1a: no crypto import for a value nobody has any reason to forge. It is
  // a staleness check between this engine and this engine, not a signature.
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + "-" + choices.length;
}

/* The screen is only the LAST few lines of dialog; everything above it is
 * transcript that happens to contain numbered lists of its own. Bounded so a
 * conversation about "1. do this 2. do that" twenty lines up can never be read
 * as a set of buttons. */
const SCAN_LINES = 40;
const CONTEXT_MAX = 12;

/**
 * Parse a pane's visible screen into the question it is waiting on.
 *
 * Returns null for anything that is not unambiguously a numbered dialog at the
 * bottom of the screen. Null is a real answer here and the caller must show it
 * as such.
 */
export function parseAsk(screen: string): Ask | null {
  const raw = stripPaneControls(screen).replace(/\r/g, "").split("\n");
  // Trailing blank lines are not evidence of anything.
  while (raw.length && raw[raw.length - 1]!.trim() === "") raw.pop();
  const lines = raw.slice(Math.max(0, raw.length - SCAN_LINES));
  if (!lines.length) return null;

  /* Walk up from the bottom collecting choice lines. Blanks, rules and hint
   * lines are allowed between them: the AskUserQuestion form draws the prompt
   * box border BETWEEN choice 4 and choice 5, so a rule cannot end the run.
   * Anything else ends it. */
  const found: Array<{ i: number; n: number; label: string }> = [];
  let firstIdx = -1; // index of the "1." line
  let sawChoice = false;
  const indentOf = (line: string) => line.length - line.trimStart().length;
  /* Content lines met BELOW the last choice, judged once the last choice is
   * known rather than on sight. See the note where they are collected. */
  const trailing: number[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const m = CHOICE_RE.exec(line);
    if (m) {
      const n = Number(m[1]);
      found.push({ i, n, label: m[2]! });
      sawChoice = true;
      if (n === 1) {
        firstIdx = i;
        break;
      }
      continue;
    }
    if (line.trim() === "" || isRule(line) || HINT_RE.test(line)) continue;
    /* A content line.
     *
     * BELOW the last choice it disqualifies the whole screen, and that is the
     * guard that separates a live dialog from a numbered list somebody wrote in
     * a reply. A dialog is the BOTTOM of the screen: under its last choice
     * there is nothing but blank lines and the terminal's own key hints. A
     * numbered list in the transcript has the rest of the turn under it -- the
     * spinner, the rule, the empty prompt box -- and a bare "❯" prompt box is
     * itself herdr's proof that the pane is idle rather than waiting.
     *
     * WHAT IT MAY NOT DO IS DECIDE ON SIGHT, because the LAST choice's own
     * description wraps under it and is therefore below it. Measured on Claude
     * Code 2.1.222's /model picker at 60 columns, where the sixth model's blurb
     * needs two rows (fixtures/pane-model-picker-2.1.222-60col.txt):
     *
     *      6. Opus 4.7 (1M)            Custom model
     *                                  (claude-opus-4-7)      <- this row
     *
     *      ● High effort (default) ←/→ to adjust
     *
     * Returning null here read that continuation as "the run is broken", so the
     * whole picker was unparseable at his own terminal width and only at his
     * width. The test that separates it from a stray line of transcript is the
     * one already applied between choices -- indented PAST the choice -- and it
     * cannot be applied until the choice is known, so the line is remembered and
     * judged below. Nothing is loosened: an unindented line still kills it. */
    if (!sawChoice) { trailing.push(i); continue; }
    const indent = indentOf(line);
    const below = found[found.length - 1];
    const belowIndent = below ? indentOf(lines[below.i]!) : 0;
    if (indent > belowIndent) continue; // description under the choice above it
    return null; // the run is broken: not one dialog
  }
  if (firstIdx < 0) return null;

  found.reverse(); // now 1..k, top to bottom
  // The numbers must be 1,2,3... with nothing missing and nothing repeated.
  for (let k = 0; k < found.length; k++) if (found[k]!.n !== k + 1) return null;
  if (found.length < 2) return null; // one "choice" is a sentence, not a dialog

  /* Now the last choice is known, so the lines under it can be judged: each has
   * to be indented past it, which is what makes it that choice's own wrapped
   * description rather than the transcript continuing underneath a numbered
   * list somebody wrote in a reply. */
  const lastIndent = indentOf(lines[found[found.length - 1]!.i]!);
  for (const i of trailing) if (indentOf(lines[i]!) <= lastIndent) return null;

  /* Each choice's description: the indented lines between it and the next one.
   * The hint that names a submit key lives here, which is how a free-text
   * choice becomes answerable at all. */
  const choices: AskChoice[] = found.map((f, k) => {
    const end = k + 1 < found.length ? found[k + 1]!.i : lines.length;
    const detailLines: string[] = [];
    /* CONTIGUOUS lines only. A blank line ends a choice's description, and it
     * has to: the dialog's own footer ("Enter to select · Esc to cancel") sits
     * a blank line below the LAST choice, and reading it as that choice's
     * description put the keyboard help inside a button. */
    for (let i = f.i + 1; i < end; i++) {
      const line = lines[i]!;
      if (line.trim() === "") break;
      if (isRule(line)) continue;
      detailLines.push(line.trim());
      if (detailLines.length >= 3) break;
    }
    const detail = detailLines.join(" ") || undefined;
    return {
      n: f.n,
      label: f.label,
      ...(detail ? { detail } : {}),
      ...(FREE_TEXT_RE.test(f.label) ? { freeText: true } : {}),
    };
  });

  /* The question: the block of prose directly above the first choice, unwrapped.
   * "Claude has written up a plan and is ready to execute. Would you like to /
   * proceed?" arrives as two lines and is one sentence. */
  let q = firstIdx - 1;
  while (q >= 0 && (lines[q]!.trim() === "" || isRule(lines[q]!))) q--;
  const questionLines: string[] = [];
  while (q >= 0 && questionLines.length < 4) {
    const line = lines[q]!;
    if (line.trim() === "" || isRule(line)) break;
    questionLines.push(line.trim());
    q--;
  }
  questionLines.reverse();
  const question = questionLines.join(" ").replace(/\s+/g, " ").trim();
  if (!question) return null;

  /* The context: what is above the question, up to the rule that opens the
   * dialog. The bash command, the file being written, the plan's title. Trimmed
   * hard -- this is a phone.
   *
   * AND IT STOPS DEAD AT THE VIEWPORT RULE, whatever it has collected. The
   * solid-rule test below cannot do that job on its own: it SKIPS the rule the
   * walk starts on ("the edge we started on"), which is right for a dialog that
   * draws an internal separator between its question and its context -- the plan
   * approval does, and without the skip its plan body is lost -- and wrong for
   * one whose question sits directly under the panel's own top edge. The /model
   * picker is the second kind, so the walk crossed the edge and kept going UP
   * INTO THE TRANSCRIPT: on a freshly started pane the app was handed eleven
   * rows of the Claude Code welcome box, ASCII logo included, as "what this
   * question is about".
   *
   * ▔ (U+2594) is not a rule a dialog draws. It is the line claude puts between
   * the transcript and the bottom panel, one per screen, and it is above the
   * dialog's own top edge when the dialog has one (the plan approval fixture has
   * both). So nothing above it belongs to the question, ever. */
  const context: string[] = [];
  for (let i = q; i >= 0 && context.length < CONTEXT_MAX; i--) {
    const line = lines[i]!;
    if (VIEWPORT_RULE_RE.test(line)) break; // transcript above, panel below
    if (DASH_RULE_RE.test(line)) continue; // fencing inside the detail block
    if (SOLID_RULE_RE.test(line)) {
      if (context.length) break; // the dialog's own top edge; above it is transcript
      continue; // the edge we started on
    }
    if (line.trim() === "") continue;
    // A transcript line, not part of the dialog: the reply above it, the prompt
    // that started the turn, the spinner. Those belong to the chat, not here.
    if (/^\s*[⏺❯✻⎿·]/u.test(line)) break;
    context.push(line.trimEnd());
  }
  context.reverse();

  return { question, context, choices, fingerprint: fingerprintOf(question, context, choices) };
}

/* --------------------------------------------------------------- screen box
 * classifyPaneBox + SGR + nonDimText moved here from herdr.ts (S1) so the
 * claude HarnessReader's parseScreen can import the screen-parse cluster
 * without herdr.ts's mux import graph. herdr.ts re-exports these, so every
 * existing import path reads unchanged.
 */
/* Does a claude pane's input box have anything in it, given an ANSI screen read?
 *
 * IT MUST BE THE ANSI FORM, and that is the whole of why this exists. An empty
 * box is not blank: a few seconds after it empties, claude paints a DIM
 * suggestion into it. herdr's `pane.read` defaults to ANSI-stripped text, which
 * throws away the one signal that separates that ghost from something a person
 * actually typed, so a stripped read calls an empty box occupied every time.
 *
 * Measured on a live pane, same instant, same box:
 *
 *   text : '❯ now echo goodbye'
 *   ansi : '❯ \x1b[0m\x1b[2mnow echo goodbye\x1b[0m\r'
 *
 * and for comparison, both forms of real content:
 *
 *   typed 120 chars : '❯ SHORTBODY aaaa…\r'                    (no SGR at all)
 *   typed 2000      : '❯ [Pasted text #1][Pasted text #2]\r'   (no SGR at all)
 *
 * So the rule is: text under an active SGR 2 (dim) is decoration, anything else
 * that is not whitespace is content. Note what that makes this: a dependency on
 * how Claude Code renders its own input box. If it ever draws a real draft dim,
 * or stops dimming the suggestion, this reads the box wrong -- so the failure
 * direction is chosen deliberately. Anything not confidently content (no box,
 * unreadable, all dim) answers FALSE, and false makes the caller type the body
 * rather than press enter at something it cannot see. A doubled message is
 * recoverable; a lost one is not.
 *
 * The box is found from its BOTTOM EDGE and the prompt marker above it, not
 * from a pair of rules: 2.1.222 prints a tip inside the top edge, and narrow
 * enough that the tip wraps there is no top edge on the screen at all
 * (classifyPaneBox below). What is inside is never interpreted
 * further: past about 900 characters claude collapses pasted input into
 * "[Pasted text #N]" placeholders, so the text itself is not on screen to be
 * recognised and "is this OUR body" cannot be asked here.
 */
/* ONE copy, exported, because everything that reads a pane has to agree on
 * what an escape sequence looks like. A caller that only wants words strips
 * with this; a caller that needs the colour keeps it. Global, so `lastIndex`
 * is reset before every use below. */
export const SGR = /\x1b\[([0-9;]*)m/g;

/* ONE STRIPPER FOR EVERY CONTROL SEQUENCE, not just SGR.
 *
 * SGR strips colour and nothing else, which was right while a screen was
 * prose plus colour. A Claude Code trust prompt drew an OSC-8 hyperlink into
 * its question:
 *
 *   ESC ]8;id=zaxmda;https://... ESC \ Security guide ESC ]8;; ESC \
 *
 * and SGR left the whole thing behind, so the app's blocked-question text
 * leaked "]8;id=zaxmda;https://...". This removes, in one place:
 *
 *   - OSC (ESC ] ... BEL | ESC \) -- removed outright. For an OSC-8 hyperlink
 *     that is exactly right: open and close are TWO OSC sequences, and the
 *     visible link text sits BETWEEN them, outside both, so it survives.
 *   - CSI (ESC [ ... final byte) -- SGR is the `m` member of that family;
 *     cursor moves, clears and private modes are the rest.
 *   - C1 controls (0x80-0x9F), including the 8-bit CSI (0x9B) and OSC (0x9D)
 *     spellings, which need the same whole-sequence walk.
 *   - any other two-byte ESC sequence (ESC c, ESC 7, a lone ST, ...).
 */
export function stripPaneControls(s: string): string {
  let out = "";
  let i = 0;
  const len = s.length;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const next = s[i + 1];
      if (next === "]") { i = oscEnd(s, i + 2); continue; }
      if (next === "[") { i = csiEnd(s, i + 2); continue; }
      i += 2;
      continue;
    }
    if (c === 0x9d) { i = oscEnd(s, i + 1); continue; } // 8-bit OSC
    if (c === 0x9b) { i = csiEnd(s, i + 1); continue; } // 8-bit CSI
    if (c >= 0x80 && c <= 0x9f) { i++; continue; }       // stray C1 control
    out += s[i];
    i++;
  }
  return out;
}

/* Index just past an OSC payload: BEL (0x07), ESC \ (ST), 8-bit ST (0x9C), or
 * end of string. */
function oscEnd(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x07) return i + 1;
    if (c === 0x1b && s[i + 1] === "\\") return i + 2;
    if (c === 0x9c) return i + 1;
    i++;
  }
  return s.length;
}

/* Index just past a CSI sequence: parameter and intermediate bytes, then the
 * final byte in 0x40-0x7E. */
function csiEnd(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    if (s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e) return i + 1;
    i++;
  }
  return s.length;
}

/* THE CONSUMPTION HELPERS (pure). The delivery guard uses these to ask a pane
 * whether the text it typed actually landed, when it has no parser for that
 * pane's screen. They are the harness-agnostic detector: a healthy composer
 * echoes what is typed, a modal swallows it. All three are pure functions of a
 * screen string, so a test asserts them without a pane.
 *
 * `flat` strips every control sequence AND all whitespace, so a containment
 * test is immune to the column the pane wrapped at and to padding rows. */

/* BOX-DRAWING AND BLOCK-ELEMENT GLYPHS, U+2500-U+259F, are composer CHROME and
 * never typed content that spans the tail.
 *
 * MEASURED, live on the testbox test box (tmux mux, opencode 1.18.29, wide
 * pane), 2026-09-20T00:14:34.729Z, session ag--7ts1_86LOwH1naw. The engine
 * typed the body, opencode's composer showed it FULLY, but wrapped it across
 * rows each drawn with a left border glyph "┃" (U+2503):
 *
 *     ┃ TEXT: Hi (Reply with the chat tool AND the speak tool. ... the full text
 *     ┃ via chat tool.)
 *
 * The typed tail straddled that wrap, so flat(screen) held
 * "...fulltextmessage┃viachattool.)" while the tail was "messageviachattool.)":
 * containment was false, the echo gate ruled refusedSwallowed ("the terminal
 * swallowed the typed text"), no enter was pressed, and delivery failed. One
 * manual enter submitted the sitting body, proving the text had landed
 * (~/.callyourcode/logs/engine.log, utterance.delivery-failed). The border
 * glyph the composer injected BETWEEN the two halves of the tail was the whole
 * of the break.
 *
 * Stripping this range removes only chrome. It can never add the tail's letters
 * to a screen that lacks them, so a modal that swallowed the text -- whose
 * screen shows its own question and choices, not the body -- still fails
 * containment and is still refused. No composer echoes a box/block glyph AS
 * typed content spanning the tail, and the strip is symmetric (applied to the
 * typed tail too, below), so a body that did contain one still matches itself. */
const TUI_CHROME_RE = /[\u2500-\u259f]/g;

export function flat(s: string): string {
  return stripPaneControls(s).replace(TUI_CHROME_RE, "").replace(/\s+/g, "");
}

/* Past this many characters a harness composer may collapse a paste into a
 * placeholder (claude measured at ~900, blocked.ts paste-collapse note; codex
 * unverified), so the typed tail is no longer a reliable witness. Above it the
 * caller falls back to a changed-screen check instead of the tail. */
export const TAIL_MAX = 600;

/* Did the tail of what we typed show up on the screen? Take the last
 * min(24, typed.length) characters of `typed`, whitespace-stripped, and test
 * containment in flat(screenText). Stripping whitespace on both sides is what
 * makes it survive the pane wrapping the line at some column. */
export function tailVisible(screenText: string, typed: string): boolean {
  // Normalise the tail with the SAME flattening applied to the screen, so the
  // chrome strip is symmetric: a body that itself contained a box/block glyph
  // still matches its own echo, and containment stays a pure text comparison.
  const tail = flat(typed.slice(-Math.min(24, typed.length)));
  if (!tail) return false;
  return flat(screenText).includes(tail);
}
function nonDimText(row: string): string {
  let dim = false, out = "", last = 0, m: RegExpExecArray | null;
  SGR.lastIndex = 0;
  while ((m = SGR.exec(row))) {
    if (!dim) out += row.slice(last, m.index);
    // "\x1b[m" is a bare reset; otherwise 0 and 22 clear dim, 2 sets it
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      /* 38/48/58 introduce a COLOUR, and its arguments are not SGR codes.
       * `38;2;R;G;B` is 24-bit foreground -- and reading that `2` as SGR 2
       * (dim) threw away the rest of the row. Claude Code paints the prompt
       * marker grey while a turn is running, so mid-turn the box stopped
       * looking like a box and delivery was refused for most of every turn,
       * on the path this engine exists to support (messages typed into a BUSY
       * pane are the queued divider). Captured:
       *   running '\x1b[0m\x1b[38;2;153;153;153m❯\xa0\x1b[0m\r' -> was '\r'
       *   idle    '❯ \r'                                        -> '❯ \r'
       * `38;5;N` is the 256-colour form and skips two instead of four. */
      if (c === 38 || c === 48 || c === 58) {
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 1;
        continue;
      }
      if (c === 0 || c === 22) dim = false;
      else if (c === 2) dim = true;
    }
    last = SGR.lastIndex;
  }
  if (!dim) out += row.slice(last);
  return out;
}

/* AND THERE ARE THREE ANSWERS, NOT TWO.
 *
 * A boolean was wrong here, and dangerously so. Claude Code does not always
 * show an input box: when it wants permission, or a plan approved, it replaces
 * the box with a CHOOSER, and enter there activates the highlighted option --
 * which defaults to Yes. Captured from a live pane, asking about a read
 * outside its cwd:
 *
 *   ──────────────────────────────────────────────────────────
 *    Read file
 *      Read(/etc/hosts)
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, allow reading from etc/ during this session
 *      3. No
 *    Esc to cancel · Tab to amend
 *
 * Two things were measured there and both decide this design. `send_text` is
 * SWALLOWED: a whole message body typed at that prompt left it byte-identical,
 * so the message is simply gone. And enter answers the prompt -- verified by
 * moving the highlight to "3. No" FIRST and pressing enter there, which
 * dismissed it without granting anything.
 *
 * So the caller has to be able to say "this is not an input box, do nothing at
 * all". Neither half of a boolean is safe: pressing enter approves something
 * nobody asked us to approve, and typing loses the message. A message reported
 * undelivered is fine. An approval he never gave is not.
 *
 * A TRAILING BOX WINS OUTRIGHT.
 *
 * The first version of this asked the chooser question over the bottom rows of
 * the WHOLE screen, with nothing requiring the screen to lack an input box. An ordinary
 * FINISHED turn that happens to end in a numbered list and a question then
 * classified as a chooser, and delivery was refused to a pane sitting idle at
 * a perfectly good input box. Captured from a live pane:
 *
 *    ⏺ 1. alpha
 *      2. beta
 *      3. gamma
 *
 *      Do you want me to start with alpha?
 *
 *    ✻ Cogitated for 1s
 *    ────────────────────────────────────────────────────────
 *    ❯
 *    ────────────────────────────────────────────────────────
 *
 * Measured over his own history: 4 of 5,472 real assistant turns end that way,
 * 0.07%. Rare, and the timing is the worst possible -- a numbered menu ending
 * "where do you want to start?" is exactly when he picks up the phone to
 * answer. Worse, the refusal changes nothing on the pane, so every retry reads
 * the same screen and refuses again: a session that can only be rescued by
 * walking to the terminal, which is the thing this product exists to avoid.
 *
 * So: the ask is looked for only in the rows BELOW THE LAST RULE, which is
 * where a trailing box has nothing but its two status lines. That is what makes
 * the box win outright without a rule about who is asked first, and it is also
 * what still refuses the one shape a trailing box does not save us from -- a
 * permission panel drawn under a rule that came out of somebody's prose. A box
 * is two things together --
 *
 *   1. a closing RULE, and
 *   2. the prompt marker directly above it, with no other edge between.
 *
 * (1) is what refuses every prompt: measured over twenty live captures, a
 * permission prompt has exactly one rule (its own panel top) or none, and its
 * question sits BELOW that rule, where the ask is looked for. (2) is what stops
 * a prompt whose question and footer have scrolled off from reading somebody
 * else's output as though it had been typed.
 *
 * This used to say "a PAIR of rules". It cannot: Claude Code 2.1.222 prints a
 * tip inside the top edge, so there is no pair, and at 60 columns the tip
 * displaces and wraps the top edge entirely so there is no top edge either.
 * Measured on a live claude at 60, 100 and 200 columns at ten moments each: the
 * pair test said `unknown` thirty times out of thirty.
 *
 * THERE WAS A THIRD CONDITION AND IT IS GONE: "the last rule is within four
 * rows of the bottom". It was a fitted constant, and measured across all
 * twenty captures it changed no verdict -- every healthy pane sits at exactly
 * three rows (box, two status lines), and every prompt is already refused by
 * (1). It was justified by a screen with two rules and a prompt-marker
 * interior, which could not be produced on a live pane: a markdown `---`
 * renders as literal dashes in claude's output, not as a full-width rule. So
 * it guarded nothing observed while costing a one-row margin -- a pane with a
 * third status row would have been refused.
 */

/* AND THE CHOOSER CARRIES THE QUESTION, because there is only one parser.
 *
 * "Is this a chooser" and "what is it asking" used to be two readers over one
 * screen -- a phrase list here, parseAsk in blocked.ts -- and two readers of
 * one thing drift. They differ only in the sentence the user is shown; both
 * refuse to send. So this derives from parseAsk, which buys the point of the
 * merge: an undeliverable message arrives WITH THE BUTTONS BESIDE IT, from the
 * same read that refused it.
 *
 * The consequence is deliberate and it is a narrowing: when parseAsk returns
 * null we do not actually know the screen is a chooser, so we no longer say so.
 * It answers `unknown`, which refuses delivery just the same and claims less.
 * Measured against the captured fixtures, exactly one screen moved: the /model
 * picker (pane-model-picker.txt) parses as null, because it draws a control row
 * ("● High effort (default) ←/→ to adjust") between its last choice and its
 * footer, and a content line below the last choice is what disqualifies a
 * screen for parseAsk -- the same rule that stops an ordinary turn ending in a
 * numbered list from being read as a set of buttons. Both verdicts refuse; only
 * the sentence changed. */
export type PaneBox =
  | { kind: "input"; hasContent: boolean }
  | { kind: "chooser"; ask: Ask }
  | { kind: "unknown" };

/** What a caller can conclude about a pane, including the two things
 *  classifyPaneBox cannot say because it never saw a screen. */
export type BoxVerdict = PaneBox["kind"] | "unreadable";

/** THE DECISION, in one place, so a test can assert it without a pane.
 *
 * Only two verdicts refuse. `chooser` is the failure this guard exists for:
 * typing there is swallowed and the enter behind it answers at the highlighted
 * Yes. `unreadable` is the read we never got, and a screen we did not see is
 * exactly where a chooser would be.
 *
 * `unknown` DELIVERS. It means we read the whole screen and found no question
 * on it; that the box matcher did not recognise the shape is a fact about the
 * matcher. Refusing on it made the app reject every message he sent for four
 * hours on 2026-08-04, telling him the session was not ready while the pane sat
 * idle at a perfectly good input box. */
export function refusesDelivery(kind: BoxVerdict): boolean {
  return kind === "chooser" || kind === "unreadable";
}

/** A full-width horizontal rule: a row of nothing but U+2500. Unchanged, and
 *  deliberately so -- what it decides (`last`, and therefore the region the
 *  chooser is looked for in) is the safety-critical half of this file, and this
 *  round had no evidence to change it with. */
const isBoxRule = (bareRow: string) => /^\s*─{4,}\s*$/.test(bareRow);

export function classifyPaneBox(screen: string): PaneBox {
  const all = screen.split("\n").map((r) => r.replace(/\r$/, ""));
  const bare = (r: string) => stripPaneControls(r);
  // trailing blank rows are padding, not distance from the box
  let end = all.length;
  while (end > 0 && bare(all[end - 1]).trim() === "") end--;
  const rows = all.slice(0, end);

  const rules = rows.map((r, i) => (isBoxRule(bare(r)) ? i : -1)).filter((i) => i >= 0);
  const last = rules[rules.length - 1];

  /* THE BOX IS FOUND FROM ITS BOTTOM, because its bottom is the only part of it
   * that is reliably on the screen.
   *
   * This used to pair two rules: the last rule before the closing one whose
   * FOLLOWING row carries the prompt marker. Two separate screens break that,
   * and both of them are what a freshly started claude actually draws.
   *
   * At 100 and 200 columns the top edge is not a rule at all: Claude Code
   * 2.1.222 prints a highlighted tip inside it, so the pair does not exist. At
   * 60 columns there is no top edge on the screen in any form: the tip
   * displaces the whole run and then WRAPS, and the closing rule wraps too.
   * Captured at t=30s, 60 columns:
   *
   *      Set up local voice conversations with Claude Code over
   *     Tailscale ──
   *     ❯
   *     ────────────────────────────────────────────────────────────
   *     ────────
   *
   * So: skip the rows the closing edge wrapped onto, then walk UP to the prompt
   * marker. That marker directly above the closing edge is the box, whatever
   * became of its lid.
   *
   * THE WALK MAY ONLY CROSS THE BOX'S OWN INTERIOR, and that is the whole of
   * what keeps it honest. The interior is the marker row and the rows the
   * message wrapped onto, which are drawn INDENTED under the marker; blank rows
   * in a typed message stay blank. Anything else starting at COLUMN ZERO is the
   * transcript above the box, and it ends the walk.
   *
   * Without that bound this reads somebody else's output as though it had been
   * typed. assembled-prompt-scrolled.txt is the screen that proves it -- a
   * permission panel whose question and footer have scrolled out, leaving its
   * rule at the bottom and, above it, the ECHO of an earlier message:
   *
   *   ❯ Read the file /etc/hosts and tell me how many lines it has
   *
   *   ⏺ Reading 1 file…
   *     ⎿  /etc/hosts
   *
   *   ────────────────────────────    <- the PANEL's rule, not a box
   *    Read file
   *
   * An unbounded walk finds that `❯` five rows up and calls the panel an input
   * box holding content. `⏺` sits at column zero, so the walk stops there.
   *
   * A RULE THE USER TYPED INSIDE THE BOX MUST NOT STOP IT EITHER, which is the
   * same rule seen from the other side: the body is drawn indented under the
   * marker, so a rule in it is indented with it. Reproduced on an idle pane at
   * a healthy input box, and it made relaying another agent's reply permanently
   * unsendable-to:
   *
   *   ────────────────────────────    <- the box opens
   *   ❯ relaying what the other agent said:
   *     ──────────────────────────    <- a rule INSIDE the body, indented
   *     options:
   *     1. rewrite it
   *     do you want one?
   *   ────────────────────────────    <- the box closes
   */
  const marked = (r: string | undefined) =>
    r !== undefined && /^[\s ]*[❯>]/.test(nonDimText(r));
  let bottom = last;
  while (bottom > 0 && isBoxRule(bare(rows[bottom - 1]))) bottom--;
  let open = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (marked(rows[i])) { open = i; break; }
    const row = bare(rows[i]);
    // blank, or indented under the marker: still inside the box. Column zero
    // (the lid, decorated or not, and any rule in prose) is not.
    if (row.trim() !== "" && !/^[\s ]/.test(row)) break;
  }
  // inclusive of the marker row: it is the box's first row, not its lid
  const inner = open < 0 ? [] : rows.slice(open, bottom);

  /* ONE PARSER, ONE CALL, over the region the structure points at.
   *
   * parseAsk (blocked.ts) wants WORDS, so it is given the stripped form --
   * `bare`, the SGR thrown away here rather than at the read, because
   * classifyPaneBox needs the colour and it is the same read. That is the whole
   * reason readPane asks for ansi and never for strip_ansi: one caller
   * discarding a byte the other depends on is how these two came apart.
   *
   * WHICH REGION, and it is not a choice between two parsers but between two
   * slices of one screen. When there are rules, the rows BELOW THE LAST ONE
   * decide it -- structurally, no distance and no fitted constant. Claude draws
   * its status lines under the input box and nothing else, while a permission
   * panel draws its question, its options and its footer under its own rule. So
   * a trailing input box wins outright by construction: the rows under its
   * closing rule are two status lines, parseAsk finds no dialog in them, and
   * the box branch below is reached.
   *
   * The screen that forces the region to be the tail rather than the whole
   * screen is fixtures/pane-prompt-after-rule-in-prose.txt: a literal U+2500
   * line inside an assistant reply pairs with the permission panel's own rule
   * into something shaped exactly like a box, whose interior even opens with
   * "> quoted". `inner` is non-empty there. Parsing the tail first is what stops
   * delivery typing at that prompt and pressing enter on "1. Yes".
   *
   * With no rules at all there is no tail to take, so the screen is the region.
   * Measured over 1,439 live samples: the rows below the last rule number 2 on
   * a healthy pane and 11 on a prompt, counted after the trailing-blank trim
   * above. Nothing here is tuned to that; it is only why the separation is
   * safe. */
  const region = rules.length ? rows.slice(last + 1) : rows;
  const ask = parseAsk(region.map(bare).join("\n"));
  if (ask) return { kind: "chooser", ask };

  if (inner.length) {
    const hasContent = inner.some((r) =>
      // strip the prompt marker (it is followed by a space or a non-breaking one)
      nonDimText(r).replace(/^[\s ]*[❯>][\s ]?/, "").replace(/[\s ]/g, "").length > 0);
    return { kind: "input", hasContent };
  }

  return { kind: "unknown" };
}


/* The reader-facing spelling of classifyPaneBox: the
 * `kind` union flattened to `box`, `hasContent`/`ask` carried only when the
 * verdict has them. Same read, same bytes, one name. */
export type ScreenBox =
  | { box: "input"; hasContent: boolean }
  | { box: "chooser"; ask: Ask }
  | { box: "unknown" };

export function parseScreen(ansi: string): ScreenBox | null {
  const box = classifyPaneBox(ansi);
  if (box.kind === "input") return { box: "input", hasContent: box.hasContent };
  if (box.kind === "chooser") return { box: "chooser", ask: box.ask };
  return { box: "unknown" };
}
