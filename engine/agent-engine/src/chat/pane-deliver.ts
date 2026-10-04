/* PANE DELIVERY (L2 domain): the delivery-guard doctrine, the unsubmitted
 * memory, the ONE pane keyboard queue, deliverToPane, and the restart
 * machinery.
 *
 * The rule everything here serves: A KEY IS NEVER PRESSED ON A SCREEN NOBODY
 * JUST LOOKED AT, and a doubled message is recoverable where a lost one is
 * not. Talks to the ADAPTER ONLY: the screen read, the guarded
 * sendInput and the interrupt are adapter verbs; the two shell keystrokes the
 * restart types stay on the raw mux seam because there is no adapter verb for
 * shell typing yet (see the scope note below).
 *
 *   bun test agent-engine/src/pane-deliver.test.ts
 */

import { PaneNotReady, deliverSettleMs, type DeliverDeps } from "../adapters/mux-adapter.ts";
import { watchRestart, type RestartSighting } from "../terminal/restart.ts";
import type { PaneBox } from "../terminal/herdr.ts";
import type { Ask } from "../terminal/blocked.ts";
import type { AgentLabel } from "../runtime/agents.ts";
import type { AgentStatus } from "../terminal/mux.ts";

export type PaneSession = {
  id: string;
  muxHandle: string;
  alive: boolean;
  agent: AgentLabel;
  /* AgentStatus, the same five keys session-state.ts stores, not a bare string.
   * The delivery bag this module builds is consumed as a DeliverSession, whose
   * status has always been AgentStatus. */
  status: AgentStatus;
};

export type PaneDeliverDeps = {
  parseScreen(paneId: string): Promise<{ box: PaneBox | { kind: "unreadable" }; text: string }>;
  publishAsk(paneId: string, ask: Ask): void;
  /* The delivery collaborators are named ONCE, by the adapter that consumes
   * them. This used to re-spell the bag inline, and the copy drifted: it typed
   * the session's `status` as a bare string where DeliverSession has always had
   * AgentStatus, so the composition root's own bag would not go through. */
  sendInput(paneId: string, text: string, deliveryId: string, takenAt: number | undefined,
    deps: Omit<DeliverDeps, "mux">): Promise<void>;
  canParseScreen(paneId: string): boolean;
  interrupt(paneId: string): Promise<void>;
  /* Scope note: shell keystrokes for the restart command only. */
  sendText(paneId: string, text: string): Promise<void>;
  sendKeys(paneId: string, keys: string): Promise<void>;
  /* Re-bind a pane to its EXISTING agent id (session-state adoptAgentId): the
   * restart uses it to hold the pane's identity across the quit/start gap, the
   * same way /new-session binds the pre-minted id to a fresh handle. */
  adoptAgentId(handle: string, agentId: string): void;
  sessionOf(id: string): PaneSession | undefined;
  sessionByHandle(handle: string): PaneSession | undefined;
  /* This harness kind's own restart gone-wait ceiling (its reader's
   * quit.waitMs), or null for the shipped default. The adapter owns the reader
   * seam; this module only asks how long THIS agent is allowed to take to quit
   * before the honest refusal. Optional so a delivery wiring that predates it
   * (and every non-restart caller) reads as no per-harness override. */
  quitWaitMs?(kind: string): number | null;
  /* This harness kind's own restart quit key sequence (its reader's quit.keys),
   * or null for the shipped default (RESTART_QUIT_PRESSES x "ctrl+c"). The
   * adapter owns the reader seam; this module only asks WHICH keys quit THIS
   * harness. Optional so a delivery wiring that predates it reads as the
   * default. */
  quitKeys?(kind: string): string[] | null;
};

let deps: PaneDeliverDeps | null = null;
export function initPaneDeliver(d: PaneDeliverDeps): void {
  deps = d;
}
const D = (): PaneDeliverDeps => {
  if (!deps) throw new Error("pane-deliver not initialised");
  return deps;
};

/** TEST ONLY: forget the deps, the stranded-body notes and the keyboard chain,
 *  so a second in-process wiring cannot press enter on a note the first one
 *  left about a pane that no longer exists. No-op in production, which never
 *  re-wires. */
export function resetForTest(): void {
  unsubmitted.clear();
  deliverChain = Promise.resolve();
  deps = null;
}

/* Type into the pane, then submit: herdr send_text does not press enter.
 *
 * One global chain so two near-simultaneous messages cannot interleave their
 * text/enter pairs. The pause between text and enter is load-bearing: claude's
 * TUI takes the rapid burst as one bracketed paste, and an enter inside that
 * window becomes a newline IN the input instead of a submit (user-visible as
 * "message typed but never sent"). Enter retries once.
 *
 * AND A RETRY DOES NOT TYPE THE BODY A SECOND TIME.
 *
 * This is two RPCs and only the pair is a delivery. If the text lands and the
 * enter does not, the caller reports a failure it believes -- no chat entry,
 * "not delivered" to the app -- while the whole body is sitting in the pane's
 * input, typed and unsubmitted. The app's answer to a failure is to send it
 * again, and that second attempt typed the same body onto
 * the end of the stranded one: the agent read the message twice, joined.
 *
 * SO THE ENGINE REMEMBERS WHAT IT TYPED AND COULD NOT SUBMIT, and a delivery
 * of that same body presses enter instead of typing it again. One nullable
 * note per pane, dropped the moment an enter lands.
 *
 * I tried to clear the input instead, which needs no memory at all, and
 * measured it on a real pane rather than reasoning about it. Every key that
 * looks like "clear the line" is scoped to a VISUAL line, so on a body that
 * wraps they clear one row of it:
 *
 *   ctrl+u          kills the last visual line; the rest stays. On a 300-char
 *                   wrapped body it took the box from 5 rows to 4, so even
 *                   "N of them empties it" is only true for large N.
 *   ctrl+a ctrl+k   kills the first visual line; the rest stays
 *   escape          does nothing to the buffer at all
 *   ctrl+c          empties an IDLE box in one key. Mid-turn the first press
 *                   is eaten by the interrupt and the body survives; it takes
 *                   a second one.
 *
 * ctrl+c is the only one that clears outright, and it is disqualified by the
 * case this engine deliberately supports: messages are typed into panes that
 * are BUSY (that is what the queued divider is), and ctrl+c there interrupts
 * the agent's turn.
 *
 * It also has a worse flaw. Clearing is unconditional, so it silently destroys
 * whatever the user had half-typed into that pane himself. Appending to his
 * half-sentence is bad; deleting it without telling him is the failure class
 * this codebase keeps having to fix. The note below touches nothing it did
 * not put there.
 *
 * AND THE NOTE ONLY PROPOSES. THE PANE DECIDES.
 *
 * Remembering what we typed is not the same as knowing it is still there, and
 * the difference is a message that vanishes. The app's own Stop button sends
 * ctrl+c (onInterrupt), which empties an idle box; a failed delivery looks
 * exactly like a stuck session, so pressing Stop and then send is the natural
 * thing to do. Measured on a live pane: at an empty box a following enter
 * returns success and submits NOTHING. The engine would then write the chat
 * entry and draw the bubble for a message the agent never got. A human
 * pressing ctrl+c at the keyboard does the same and tells us nothing, so no
 * amount of tracking our OWN actions closes it -- which is why the read is the
 * only mechanism here, and why onInterrupt deliberately clears nothing.
 *
 * So before the blind enter, the pane is read, and the enter is only sent if
 * the input box still has something in it. That is a check, not a belief.
 *
 * WHAT THE READ CAN AND CANNOT SEE, measured rather than assumed:
 *
 *   - an EMPTY input box is answerable, but ONLY from the ANSI read: claude
 *     paints a dim suggestion into an empty box a few seconds after it empties,
 *     and a stripped read cannot tell that from a draft. inputBoxHasContent()
 *     in herdr.ts holds the measurements and the rule.
 *   - the CONTENT is not readable. Claude Code collapses pasted input into
 *     "[Pasted text #N]" placeholders from about 900 characters (120 chars
 *     renders literally; 2000 came back as two placeholders). So "is that OUR
 *     body" cannot be asked of the screen, and this does not try to.
 *
 * The gap that leaves: the user clears our body and types their own, and we
 * submit theirs. Far narrower than the drop it replaces, and unlike the drop
 * it is visible to the person it happens to. Every other uncertainty -- read
 * failed, box not found, all of it dim, note missing or stale -- types the body
 * instead, because a doubled message is recoverable and a lost one is not.
 *
 * What this still does NOT fix: a stranded body is stranded if the retry never
 * comes, and a different message typed after one lands on top of it. Both are
 * today's behaviour, unchanged, and neither loses anything.
 */
/** The shipped settle, re-exported for the callers that only want to name the
 *  number. The restart command above uses deliverSettleMs() instead, so the
 *  pause between a text and its enter is ONE measurement wherever it happens.
 *  The ONE definition lives in adapters/mux-adapter.ts; re-exporting it (rather
 *  than a second literal 250) keeps the number and its DELIVER_SETTLE_MS env
 *  knob in one place for both readers. */
export { DELIVER_SETTLE_MS } from "../adapters/mux-adapter.ts";
/* One stranded-body note per pane (keyed by the pane id, so a dead pane's note
 * is purged by pane id in reconcile/restart). The note's IDENTITY -- is the
 * body sitting in this pane the SAME message this delivery is retrying -- is the
 * `deliveryId`, NOT the delivered string.
 *
 * The delivered string is more than the user's words: it ends with the reply
 * instruction, built from the session's reply level and its live MCP channels
 * (replyAskFor). Comparing on it meant that moving the reply slider between a
 * failed attempt and its retry changed the identity, so the enter-only dedupe
 * missed and the body was typed onto the stranded one -- the doubling this note
 * exists to prevent. The deliveryId (the user send's cid) is durable across the
 * injection being re-run, so it is the stable thing to match on. */
export const unsubmitted = new Map<string, { deliveryId: string; at: number }>();

/* The delivery guard's screen-read size (500 lines) moved to the adapter
 * (adapters/mux-adapter.ts BOX_READ_LINES), alongside the read itself. The
 * viewport-height rationale that lived here is now there. */

/** THREE ANSWERS, AND ONLY TWO OF THEM REFUSE.
 *
 * `unreadable` means we do not have the screen: the read threw, or herdr said
 * it was truncated. Nothing may be typed at a pane we cannot see, because the
 * screen we did not get is exactly where a permission prompt would be.
 *
 * `unknown` is different and it is NOT a reason to refuse. It means we read the
 * whole screen, found no chooser on it, and could not match the input box
 * either. On 2026-08-04 that described HIS EVERY PANE and the app refused every
 * message he sent for four hours: at 59 columns the box's closing rule wraps
 * onto two rows, and the promo banner above it renders on the same line as the
 * opening rule, so the shape the matcher looks for is not on the screen. The
 * box was right there, `❯` and all.
 *
 * The guard exists for ONE failure -- typing into a chooser, where the message
 * is swallowed and the enter behind it answers at the highlighted Yes -- and
 * that failure is `chooser`, which parseAsk finds. Refusing on `unknown` too
 * bought nothing and cost the product. Fail closed where we are blind; deliver
 * where we can see and there is no question on the screen. */
/* ONE READ, and the caller says whether it wants the words too.
 *
 * The delivery guard only ever needed the verdict. The restart watcher needs
 * the screen as well, because the failure it exists to catch announces itself
 * in words ("No conversation found with session ID") on a pane that classifies
 * as nothing at all. Two readers would be two round trips and, worse, two
 * screens: the verdict and the words have to come from the SAME capture or the
 * watcher can refuse a screen it never saw. */
export async function readPaneScreen(paneId: string):
  Promise<{ box: PaneBox | { kind: "unreadable" }; text: string }> {
  /* The screen read moves behind the adapter (adapter.parseScreen). Core
   * keeps only the chooser publication, which fills the ask cache from the same
   * read the delivery guard already made. The truncated/unreadable handling and
   * its log line live in the adapter now. */
  const { box, text } = await D().parseScreen(paneId);
  if (box.kind === "chooser") D().publishAsk(paneId, box.ask);
  return { box, text };
}

export async function paneBox(paneId: string): Promise<PaneBox | { kind: "unreadable" }> {
  return (await readPaneScreen(paneId)).box;
}

let deliverChain: Promise<void> = Promise.resolve();
/* THE ONE QUEUE for anything that touches a pane's keyboard.
 *
 * Messages went through it already; answers to a dialog have to go through the
 * SAME one, not a second chain of their own. A keypress that lands between
 * somebody else's send_text and its enter answers the wrong thing and submits
 * the wrong thing, and both halves look fine in isolation. */
export function onPaneKeyboard<T>(fn: () => Promise<T>): Promise<T> {
  const next = deliverChain.then(fn);
  deliverChain = next.then(() => {}, () => {});
  return next;
}
/* Delivery routes through adapter.sendInput. The single deliverToPane
 * definition lives in adapters/mux-adapter.ts; this binding passes the server's
 * own collaborators -- its `unsubmitted` map, the ONE keyboard queue, the
 * Session-registry lookup and the chooser-publishing paneBox -- as the deps
 * override, so the call sites below stay unchanged and behaviour is identical.
 * (mux stays the adapter's own: the adapter was built over the same `mux`.) */
export const deliverToPane =
  (paneId: string, text: string, deliveryId: string, takenAt?: number): Promise<void> =>
  D().sendInput(paneId, text, deliveryId, takenAt, {
    unsubmitted,
    onPaneKeyboard,
    sessionFor: (handle) => {
      const s = D().sessionByHandle(handle);
      return s ? { agent: s.agent, status: s.status } : undefined;
    },
    canParseScreen: (handle) => D().canParseScreen(handle),
    /* readPaneScreen, not paneBox: the guard needs the raw screen text (the echo
     * gate and the non-claude tail checks measure against it), and passing
     * readPaneScreen keeps the chooser publication riding the SAME read. */
    readScreen: readPaneScreen,
  });

/* HOW THIS ENGINE STARTS CLAUDE. One line, because there is one answer:
 * every session it starts is started the way he starts one by hand.
 *
 *   claude --dangerously-skip-permissions               fresh
 *   claude --dangerously-skip-permissions --resume <id> the same conversation
 *
 * The flag is his, not this engine's invention: it is what his panes are
 * already running, and coming back without it means a session that stops for
 * approval on everything it used to do. Measured on this machine 2026-08-05,
 * `ps` over every live claude: 18 of 20 interactive panes carry either
 * `--dangerously-skip-permissions` or its long form `--permission-mode
 * bypassPermissions`. The two that did not were started by the plus button.
 *
 * WHY /new-session CARRIES IT TOO. The plus button exists so work can start
 * without going to the machine, and the first thing a bare `claude` does in a
 * directory it has not been run in is stop and ask whether to trust the
 * folder. That question cannot be answered usefully from a phone -- it is a
 * modal on a terminal he is not standing at -- and it is the first thing that
 * happened when the button first worked (`.run/engine.log`, 2026-08-05
 * 17:59:56: `answer.send session=w6:p1X choice=1 label="Yes, I trust this
 * folder"`, eleven seconds after `[new-session] w6:p1X in /Users/example`).
 *
 * IT GRANTS NO REACH THE ROUTE DID NOT ALREADY HAVE. /new-session refuses any
 * cwd that is not ENGINE_HOME or a directory herdr already has an agent in, so
 * the only places this can run are this user's own home and directories he is
 * already running claude in -- with this same flag. It cannot reach another
 * host: herdr's socket is local, and each host's engine starts its own panes.
 *
 * `--resume` takes the id herdr reads out of claude's own hook state.
 *
 * SOURCED FROM THE READER TABLE now (adapters/), not a bare literal here,
 * so the one place that spells out how to launch each agent is the claude
 * reader's launch command. /new-session still spawns claude specifically (it
 * takes no agent parameter today), so it reads the claude reader by name. */
/* THE RESTART LADDER'S TIMINGS.
 *
 * Real time, all of it, and unavoidably so: this is a sequence of keystrokes at
 * a terminal, waiting on another process to quit and a shell to come back. There
 * is no logical clock to advance, only a real one to wait on.
 *
 * So they are read from the environment on every use, the same seam
 * DELIVER_DEADLINE_MS and STRANDED_TTL_MS already are, for the same reason: a
 * module const is fixed by the import that loaded this file, so a seam test
 * cannot shorten one at file scope. Production sets none of these and gets the
 * shipped numbers below on every call. Nothing writes them but a test.
 *
 * ctrl+c ONCE INTERRUPTS AND TWICE QUITS: the first breaks whatever turn is
 * running, the second lands on an empty prompt and is the one that exits. The
 * third is for the pane that was already idle, where the first press was the
 * one that armed the confirmation. */
const num = (key: string, fallback: number): number => Number(process.env[key]) || fallback;
const RESTART_QUIT_PRESSES = () => num("CYC_RESTART_PRESSES", 3);
const RESTART_PRESS_MS = () => num("CYC_RESTART_PRESS_MS", 500);
/* How long to wait for herdr to stop listing an agent on the pane, and how
 * often to look. Its event subscription usually reports this in well under a
 * second; the ceiling is sized for the fallback, a 15s resnapshot poll. */
const RESTART_GONE_MS = () => num("CYC_RESTART_GONE_MS", 20_000);
/* THE GONE-WAIT IS PER HARNESS. Most harnesses quit inside the shipped default;
 * pi flushes on SIGINT and needs longer (readers/pi.ts quit.waitMs), so the
 * ceiling is resolved from the agent kind, not one literal for all of them.
 *
 *   1. CYC_RESTART_GONE_MS_<KIND> -- a per-harness env override, the seam a
 *      test shrinks so a slow harness's wider window stays hermetic, and the
 *      knob to bump one harness in production without a redeploy.
 *   2. the harness's own reader.quit.waitMs (via the adapter).
 *   3. the shipped default (CYC_RESTART_GONE_MS, 20s) for every harness that
 *      declares nothing -- claude/codex/opencode are unchanged.
 *
 * It is only a CEILING: waitForAgentGone returns the instant the agent leaves,
 * so a wider window never slows a restart that quits promptly. It only widens
 * how long a slow one may take before the refusal, and the refusal still fires
 * for a harness that genuinely will not quit. */
const restartGoneMs = (kind: string): number => {
  const per = Number(process.env[`CYC_RESTART_GONE_MS_${kind.toUpperCase()}`]);
  if (per) return per;
  const reader = D().quitWaitMs?.(kind) ?? null;
  if (reader) return reader;
  return RESTART_GONE_MS();
};
const RESTART_GONE_POLL_MS = () => num("CYC_RESTART_GONE_POLL_MS", 250);
/* ...and how long the shell gets to be a shell again afterwards. */
const RESTART_SHELL_MS = () => num("CYC_RESTART_SHELL_MS", 600);
/* And how long to watch the restarted pane FOR CLAUDE TO DRAW ITSELF. Not for
 * a process to appear: that was the old ceiling's job and it is why eight
 * seconds was enough. Rendering is slower than starting -- a fresh `claude`
 * takes a couple of seconds, `--resume` on a long conversation takes longer
 * because it replays it -- and every second spent here is a second that turns
 * "cannot tell" into an answer. The app's own timeout (store.ts) is sized to
 * cover this plus RESTART_GONE_MS. */
const RESTART_WATCH_MS = () => num("CYC_RESTART_WATCH_MS", 15_000);
const RESTART_WATCH_STEP_MS = () => num("CYC_RESTART_WATCH_STEP_MS", 1_000);

/** Wait until the pane has no agent on it, or give up. True = it quit.
 *
 * Keyed by the STABLE session id, not the pane: the sessions map is keyed that
 * way now, so a lookup by pane id would miss and read as "already gone". The
 * object is re-fetched each turn because onAgents replaces it on every snapshot. */
export async function waitForAgentGone(sid: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!D().sessionOf(sid)?.alive) return true;
    await new Promise((r) => setTimeout(r, RESTART_GONE_POLL_MS()));
  }
  return !D().sessionOf(sid)?.alive;
}

/* Quit the agent, type the command again, then SAY WHAT IS ACTUALLY ON THE
 * PANE. That last part is the point of the whole function.
 *
 * A restarted session lands on a question a person has to answer in the
 * terminal ("go to tui and accept whatever", his words) often enough that
 * reporting "restarted" and stopping there leaves a chat that looks alive and
 * is not. So the pane is read afterwards, and what comes back is a SIGHTING
 * (restart.ts) rather than a sentence: the caller needs to know whether
 * anything was seen, not only what to print. readPaneScreen() publishes a
 * chooser as this session's ask on its way past, so the buttons for it reach
 * the app from the same read.
 *
 * WHAT THE WATCH WAITS FOR IS CLAUDE ON THE SCREEN. It used to return the
 * moment `sessions.get(paneId).alive` went true, which is herdr noticing a
 * process. `claude --resume <id>` for a conversation this machine has never
 * held is a process for about a second before it prints "No conversation
 * found" and exits, so that check reported "(Restarted, resuming the previous
 * conversation.)" over a pane sitting at a shell prompt -- and logged it into
 * his chat. Nothing in this loop consults aliveness any more.
 *
 * On the ONE keyboard queue, like every other thing that types into a pane: a
 * message delivery landing between the quit and the command would type itself
 * at a shell prompt. */
export function restartPane(s: PaneSession, mode: "fresh" | "resume", cmd: string): Promise<RestartSighting> {
  const paneId = s.muxHandle; // herdr RPCs target the live pane
  const sid = s.id;        // aliveness is tracked under the stable id
  return onPaneKeyboard(async () => {
    console.log(`[restart] ${paneId}: quitting (${mode})`);
    /* THE QUIT KEYS ARE PER HARNESS. Most harnesses quit on repeated ctrl+c;
     * pi does not take ctrl+c at all and quits on ctrl+d at an empty input
     * (readers/pi.ts quit.keys), so the sequence is resolved from the agent
     * kind, not one loop for all of them.
     *
     * DEFAULT (no keys declared): the exact shipped behavior, RESTART_QUIT_PRESSES
     * presses of the adapter's interrupt verb (ctrl+c), one press per step
     * RESTART_PRESS_MS apart -- byte-identical to before this seam, for
     * claude/codex/opencode and every harness that declares nothing.
     *
     * KEYED: the reader's own ordered sequence, pressed ONCE through (no repeat
     * spam), one key per step with the SAME spacing, via sendKeys. For pi this
     * is ctrl+c then a single ctrl+d; the reader's comment carries why a second
     * ctrl+d must never be sent. */
    const quitKeys = D().quitKeys?.(s.agent.id) ?? null;
    if (quitKeys && quitKeys.length) {
      for (const key of quitKeys) {
        await D().sendKeys(paneId, key);
        await new Promise((r) => setTimeout(r, RESTART_PRESS_MS()));
      }
    } else {
      for (let i = 0, n = RESTART_QUIT_PRESSES(); i < n; i++) {
        /* The quit is the adapter's interrupt verb, one press per loop step
         * (ctrl+c once interrupts, three times quits; RESTART_QUIT_PRESSES below). */
        await D().interrupt(paneId);
        await new Promise((r) => setTimeout(r, RESTART_PRESS_MS()));
      }
    }
    if (!(await waitForAgentGone(sid, restartGoneMs(s.agent.id)))) {
      /* NOTHING WAS TYPED AT THE SHELL, because there is no shell: the agent is
       * still up there and the command would go into its prompt as a message.
       * A wedged session is exactly what this control is reached for, so this
       * is a real outcome and not a corner. */
      /* Name the keys that were actually pressed: the keyed path (pi) quits
       * with its own sequence, and telling the user "did not take ctrl+c"
       * there described a press that never happened. */
      const quitDesc = quitKeys && quitKeys.length ? quitKeys.join(" then ") : "ctrl+c";
      throw new PaneNotReady("the agent did not quit",
        `(not restarted: it is still running in the terminal and did not take ${quitDesc}. ` +
        "Quit it there and start it again.)");
    }
    /* The pane's own text is gone with the agent, and so is any half-typed
     * message we were holding a note about: it belonged to a prompt that no
     * longer exists. */
    unsubmitted.delete(paneId);
    /* RE-BIND THE PANE TO THIS SAME AGENT, before the fresh process comes back.
     *
     * waitForAgentGone above waited for reconcile to mark the row dead, which
     * also marks the pane binding dead (markBindingDead). The restart types
     * `env CYC_AGENT_ID=<this id>` into the pane, but on herdr nothing reads
     * that env into the mux evidence (PREMINT_SOURCE is tmux-only, parsed off a
     * SPAWN command, not a typed one), and an opencode session announces only
     * at session.idle, so the fresh pane re-appears with no id and no live
     * binding: carriedAgentOf finds nothing and reconcile mints a PROVISIONAL
     * twin, leaving /agents on the old id and the reconciler on the new one.
     * Adopting the existing id here re-records the (now-dead) binding alive, so
     * the silent fresh pane resolves back to this agent by binding, exactly as
     * /new-session binds its pre-minted id. `sid` is the stable agent id (the
     * sessions map is keyed by it). */
    D().adoptAgentId(paneId, sid);
    /* herdr reporting no agent is claude's own state going away, and the shell
     * underneath needs a moment after that before it is a shell again --
     * newTab() pauses for the same reason on a pane it has just created. A
     * command typed a beat too early goes into a prompt that is still there. */
    await new Promise((r) => setTimeout(r, RESTART_SHELL_MS()));
    console.log(`[restart] ${paneId}: ${cmd}`);
    /* SCOPE NOTE: this command is typed into a SHELL, not an agent input,
     * and must stay on the server's one keyboard queue (onPaneKeyboard, the
     * caller above) so a message delivery cannot land between the quit and the
     * command. sendText/sendKeys are the adapter's RAW shell-typing verbs,
     * deliberately bypassing sendInput (which wraps deliverToPane's chooser
     * guard and the adapter's own queue, both meant for agent input, not a
     * shell). */
    await D().sendText(paneId, cmd);
    await new Promise((r) => setTimeout(r, deliverSettleMs()));
    await D().sendKeys(paneId, "enter");

    const sighting = await watchRestart(async () => {
      const { box, text } = await readPaneScreen(paneId);
      return {
        kind: box.kind,
        question: box.kind === "chooser" ? box.ask.question : null,
        screen: text,
      };
    }, { windowMs: RESTART_WATCH_MS(), stepMs: RESTART_WATCH_STEP_MS() });
    console.log(`[restart] ${paneId}: ${sighting.seen}` +
      (sighting.seen === "waiting" ? ` on "${sighting.question}"` : ""));
    return sighting;
  });
}

