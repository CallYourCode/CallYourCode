// THE DELIVERY STATE MACHINE: deliverToPane's seven incident-born guards, run
// as one explicit, unit-testable sequence of states.
//
// This module is a BEHAVIOUR-PRESERVING restructure of the body that used to
// live inline in deliverToPane (adapters/mux-adapter.ts). Every timing, every
// refusal message, every log line, every read is here in the same order and
// byte-identical: the win is legibility and testability, not new semantics. If
// a change here changes what HAPPENS, it is a bug, not an improvement.
//
// The seam is unchanged: deliverToPane still lives in mux-adapter.ts, still
// wraps the ONE keyboard queue (onPaneKeyboard), and now runs this machine and
// maps its typed outcome back to the SAME PaneNotReady / DeliveryStranded it
// always threw, with the verbatim message strings. NOTHING imports this module
// except mux-adapter.ts.
//
// Injection: runDeliveryMachine takes an `io` mirroring DeliverDeps exactly
// (minus onPaneKeyboard, which the wrapper owns) so a unit test drives it with
// no mux and no herdr. The five delivery timings are DEFINED in mux-adapter.ts
// and imported here, so there is one definition of each and no new literal.

import { refusesDelivery, flat, tailVisible, TAIL_MAX, type PaneBox } from "../terminal/blocked.ts";
import type { DeliverDeps } from "../adapters/mux-adapter.ts";
import {
  settleMs,
  confirmSettleMs,
  restrandSettleMs,
  reEchoSettleMs,
  strandedTtlMs,
  deliverDeadlineMs,
} from "../adapters/mux-adapter.ts";

/* The machine's collaborators: today's DeliverDeps exactly, minus the keyboard
 * queue. onPaneKeyboard belongs to the wrapper (deliverToPane) -- the machine
 * runs INSIDE one already-taken slot and never touches the queue itself. */
export type DeliveryIo = Omit<DeliverDeps, "onPaneKeyboard">;

/* THE STATES, one per row of the mapped flow. This union is documentation the
 * type checker enforces: it is the vocabulary the machine's comments use, and
 * nothing outside this file names a state. The machine walks them in the order
 * they are written; the terminal ones resolve to a DeliveryOutcome. */
export type DeliveryState =
  | "queued"
  | "gateDeadline1"
  | "gateBlocked"
  | "readPre"
  | "verdict"
  | "noteCheck"
  | "skipType"
  | "gateDeadline2"
  | "type"
  | "settle"
  | "echoGate"
  | "enter"
  | "confirmSettle"
  | "readPost"
  | "restrandCheck"
  | "consumedForeign";

/* THE EIGHT TERMINAL OUTCOMES. `delivered` and `unconfirmed` are both success
 * (the wrapper returns void for either); the six refusals carry the VERBATIM
 * `why`/`tell` the wrapper hands to the error class. `stranded` maps to
 * DeliveryStranded (retry presses enter only); every `refused*` maps to
 * PaneNotReady (retry types the body fresh). The kind is kept distinct from the
 * error class it maps to so a unit test can pin each one by name. */
export type DeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "unconfirmed" }
  | { kind: "stranded"; why: string; tell: string }
  | { kind: "refusedTimeout"; why: string; tell: string }
  | { kind: "refusedBlocked"; why: string; tell: string }
  | { kind: "refusedUnreadable"; why: string; tell: string }
  | { kind: "refusedChooser"; why: string; tell: string }
  | { kind: "refusedSwallowed"; why: string; tell: string };

/* `took` is WHEN THE ENGINE TOOK THIS MESSAGE (see deliverToPane): the deadline
 * measures from it, not from the moment this machine starts, because there are
 * two queues in front of the keystroke and both hold his message. */
export async function runDeliveryMachine(
  io: DeliveryIo,
  paneId: string,
  text: string,
  deliveryId: string,
  took: number,
): Promise<DeliveryOutcome> {
  const outOfTime = () => Date.now() - took >= deliverDeadlineMs();
  /* The two deadline gates share this refusal (rows 1 and 6): the elapsed count
   * is computed at the moment the gate fires, exactly as the inline gaveUp did. */
  const gaveUp = (where: string): DeliveryOutcome => ({
    kind: "refusedTimeout",
    why:
      `the session did not take this message within ${Math.round((Date.now() - took) / 1000)}s ` +
      `(${where}); nothing was typed at the pane`,
    tell: "(not sent: that session's terminal is not answering. Nothing was typed, so send it again.)",
  });

  // STATE gateDeadline1 (row 1): the deadline gate at the queue front.
  if (outOfTime()) return gaveUp("it never reached the front of the pane queue");

  const s = io.sessionFor(paneId);
  const canParse = io.canParseScreen(paneId);

  // STATE gateBlocked (row 2): a foreign pane whose session is blocked cannot be
  // typed at, because this engine cannot read that agent's prompt.
  if (s && !canParse && s.status === "blocked") {
    return {
      kind: "refusedBlocked",
      why:
        `${s.agent.name} is waiting for an answer in the terminal and this engine cannot ` +
        `read that agent's prompt, so nothing was typed`,
      tell: "(not sent: that session is waiting for an answer in the terminal. Answer it there.)",
    };
  }

  /* STATE readPre (row 3): THE ONE PRE READ, made for every pane now (the read
   * moved out of the old canParse conditional). For a pane whose harness this
   * engine can parse the box verdict is used exactly as before; for one it
   * cannot, the claude parser has no authority over a foreign screen, so its
   * verdict is discarded and only the raw `text` is kept as `pre` for the echo
   * gate below. The chooser publication rides this read (in readScreen). */
  const read = await io.readScreen(paneId);
  const pre = read.text;
  if (!canParse && read.box.kind === "unreadable") {
    /* F3: fail closed where we are blind, for non-claude panes too. Today a
     * non-claude pane is never read at all; now that it is, a failed or
     * truncated read is a refusal rather than a blind type. */
    return {
      kind: "refusedUnreadable",
      why: "the pane's screen could not be read, so nothing was typed",
      tell: "(not sent: that session's screen could not be read, so nothing was typed)",
    };
  }

  // STATE verdict (row 4): the box verdict. A foreign screen is forced to
  // `unknown` (parser has no authority); `unknown` LOGS and delivers anyway;
  // chooser/unreadable refuse.
  const box: PaneBox | { kind: "unreadable" } = canParse ? read.box : { kind: "unknown" };
  if (box.kind === "unknown") {
    console.log(`[deliver] ${paneId}${s ? ` (${s.agent.id})` : ""}: no chooser on screen and ` +
      `no input box matched; delivering anyway (the guard is for choosers, not for shapes it fails to match)`);
  }
  if (refusesDelivery(box.kind)) {
    if (box.kind === "chooser") {
      return {
        kind: "refusedChooser",
        why:
          "the pane is asking the user to choose (a permission or plan prompt); typing there " +
          "is swallowed and enter would answer it, so nothing was sent",
        tell: `(not sent: that session is waiting on "${box.ask.question}")`,
      };
    }
    return {
      kind: "refusedUnreadable",
      why: "the pane's screen could not be read at all, so nothing was sent",
      tell: "(not sent: that session's screen could not be read, so nothing was typed)",
    };
  }

  /* STATE noteCheck (row 5): is the body still sitting in the box from a failed
   * attempt? A believable note is one for the SAME delivery id (the send's cid),
   * younger than its TTL. Matching on the delivery id rather than the delivered
   * string is what lets a reply-slider change between the failed attempt and its
   * retry still dedupe: the string changes, the id does not. For a canParse pane
   * the box answers whether the body is still there; for one we cannot parse,
   * the typed tail stands in for box.hasContent -- it is all a foreign screen
   * can tell us. */
  const note = io.unsubmitted.get(paneId);
  const believable = !!note && note.deliveryId === deliveryId && Date.now() - note.at < strandedTtlMs();
  const stillThere = believable && (
    canParse ? box.kind === "input" && box.hasContent : tailVisible(pre, text));
  let typedThisAttempt = false;
  if (stillThere) {
    // STATE skipType (row 6, skip branch): the body is there, enter-only retry.
    console.log(`[deliver] ${paneId}: the body is still in the input from a failed attempt; ` +
      `submitting it rather than typing it again`);
  } else {
    if (believable) {
      console.log(`[deliver] ${paneId}: a failed attempt left a note, but the input is empty ` +
        `now (interrupted, or cleared by hand). Typing the body again.`);
    }
    // STATE gateDeadline2 (row 6): the second deadline gate, just before typing.
    if (outOfTime()) return gaveUp("the pane was still not answering when its turn came");
    // STATE type (row 6): type the body and set the note.
    await io.mux.sendText(paneId, text);
    io.unsubmitted.set(paneId, { deliveryId, at: Date.now() });
    typedThisAttempt = true;
  }

  // STATE settle (row 7): settle between the text and the enter.
  await new Promise((r) => setTimeout(r, settleMs()));

  /* STATE echoGate (row 8): between the type and the enter. It runs only when
   * text was typed THIS attempt (a stranded-body enter-only retry never
   * swallows) and only where the guard could not vouch for an input box: every
   * !canParse pane, and a canParse pane whose verdict was 'unknown'. A canParse
   * 'input' verdict SKIPS it -- parseScreen already proved a box, and claude
   * collapses long pastes so the tail may legitimately be absent. If the tail
   * did not appear (and, for long bodies, the screen did not change), the pane
   * swallowed the text: nothing is in any box, so drop the note (it would be a
   * lie) and refuse WITHOUT pressing enter, so a modal's default is never
   * activated. This is what stops the enter from ever reaching a modal's
   * default, for every harness. */
  const gateThisPane = !canParse || box.kind === "unknown";
  if (typedThisAttempt && gateThisPane) {
    /* THE ECHO: the tail on the screen, or (for a body too long to tail) the
     * screen simply changing from `pre`. One predicate, applied to each read. */
    const echoed = (screen: string) =>
      tailVisible(screen, text) ||
      (text.length > TAIL_MAX && flat(screen) !== flat(pre));
    let postType = await io.readScreen(paneId);
    if (!echoed(postType.text) && !outOfTime()) {
      /* THE SECOND READ (measured live 2026-09-20, testbox/opencode/tmux): a
       * busy composer can repaint the typed body slower than the type-settle, so
       * the first read misses an echo that IS coming, and a single read then
       * refuses forever. The confirm side already learned this on the far side
       * of the enter (restrandSettleMs); this is the same second chance before
       * it. Wait a longer settle and read ONCE more -- exactly one re-read, no
       * loop. The deadline is respected the way the gateDeadline states consult
       * outOfTime(): if his message is already out of time we skip the extra
       * settle rather than hold it longer, and fall straight to the refusal
       * below. No enter has been pressed, so a modal still swallows zero. */
      await new Promise((r) => setTimeout(r, reEchoSettleMs()));
      postType = await io.readScreen(paneId);
    }
    if (!echoed(postType.text)) {
      io.unsubmitted.delete(paneId);
      return {
        kind: "refusedSwallowed",
        why:
          "the terminal swallowed the typed text (the screen did not take it); it is showing a " +
          "prompt, menu or notice, so no enter was pressed and nothing was submitted",
        tell:
          "(not sent: that session's terminal did not take the text; it looks like it is waiting " +
          "on a prompt or menu. Answer it in the terminal.)",
      };
    }
  }

  // STATE enter (row 9): press enter, one retry on throw with a settle between.
  try {
    await io.mux.sendKeys(paneId, "enter");
  } catch {
    await new Promise((r) => setTimeout(r, settleMs()));
    await io.mux.sendKeys(paneId, "enter");
  }

  /* STATE confirmSettle (row 10): so commitDelivery is reached only past a check
   * that the keystrokes were consumed. The deadline is NOT consulted from here
   * on: aborting after the first keystroke would falsely claim "nothing was
   * typed". */
  await new Promise((r) => setTimeout(r, confirmSettleMs()));
  // STATE readPost (row 10, canParse only): read the pane back.
  const post = await io.readScreen(paneId);
  if (canParse) {
    if (post.box.kind === "input" && post.box.hasContent) {
      /* STATE restrandCheck (row 11): a busy TUI can still be showing the
       * just-submitted body here: the enter was consumed but the box has not
       * repainted empty yet. Read once more after a longer settle before
       * believing it is stranded; a box that has cleared by then was a slow
       * clear, not a strand (this is what stops a false strand from doubling the
       * message). */
      await new Promise((r) => setTimeout(r, restrandSettleMs()));
      const recheck = await io.readScreen(paneId);
      if (recheck.box.kind === "input" && recheck.box.hasContent) {
        /* Still stranded after the re-read: KEEP the note (the retry presses
         * enter only). */
        return {
          kind: "stranded",
          why: "the body was typed but the enter did not submit it; it is still in the input box",
          tell:
            "(not delivered: the message is typed into that session's input box but was not " +
            "submitted. Send it again and it will be submitted.)",
        };
      }
      /* Cleared on the re-read: consumed after a slow repaint. */
      io.unsubmitted.delete(paneId);
      return { kind: "delivered" };
    }
    if (post.box.kind === "unreadable") {
      /* STATE readPost -> unconfirmed (row 12): unconfirmed, not failed.
       * Refusing here would report not-delivered for a message that usually WAS
       * delivered, and the retry it invites is guarded by the note. Keep the
       * note, return success, log it. */
      console.log(`[deliver] ${paneId}: delivery unconfirmed (post-enter read failed)`);
      return { kind: "unconfirmed" };
    }
    /* input && !hasContent, chooser (a permission prompt the submitted message
     * itself triggered), or unknown => consumed (row 13). */
    io.unsubmitted.delete(paneId);
    return { kind: "delivered" };
  }
  /* STATE consumedForeign (row 14): !canParse: NO post-enter stranded check. The
   * stranded check is claude-only because it needs a box-bounded reader
   * (classifyPaneBox's box.hasContent, the input-box region only). A !canParse
   * reader has no parseScreen, so post.text is the FULL screen (BOX_READ_LINES
   * lines) with the transcript included. A conversational TUI (codex, opencode)
   * echoes the just-submitted user message into that transcript, so on a
   * SUCCESSFUL send the tail IS on screen: a tailVisible check here would
   * false-strand every healthy send. The pre-enter echo gate already proved the
   * input box took the text, and without a per-harness parser there is no way to
   * tell "still in the box" from "echoed in the transcript", so treat the enter
   * as consumed. */
  io.unsubmitted.delete(paneId);
  return { kind: "delivered" };
}
