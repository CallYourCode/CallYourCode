/* SESSION VERBS (L3 feature): compact, interrupt, and answering the question
 * a session is stopped on.
 *
 * The one rule the answer path exists to keep: A KEY IS NEVER PRESSED ON A
 * SCREEN NOBODY JUST LOOKED AT. The answer carries the fingerprint of the
 * question it was drawn from; the pane is re-read INSIDE the same keyboard
 * lock the press uses; a mismatch refuses rather than presses; and after the
 * keystroke the pane is read again to check the question moved on. Nothing
 * here has a default and nothing auto-answers.
 *
 *   bun test agent-engine/src/chat/answer.test.ts (rewritten with the suite redo)
 */

import { readAskNow } from "../chat/asks.ts";
import { stampTs, logChat, type ChatSession } from "../chat/chatlog.ts";
import { CONTROL_ANSWER_PREFIX, type ChatMsg } from "../chat/chatmsg.ts";
import type { Sock } from "../transport/sock.ts";

export type VerbSession = ChatSession & {
  muxHandle: string;
  viaMux: boolean;
  alive: boolean;
  agent: { id: string; name: string };
};

export type SessionVerbDeps = {
  sessionOf(id: string): VerbSession | undefined;
  launchCommand(agentId: string): string | null | undefined;
  deliverToPane(paneId: string, text: string): Promise<void>;
  /** the PaneNotReady tell, or null when the error is not that shape */
  paneNotReadyTell(e: unknown): string | null;
  interrupt(paneId: string): Promise<void>;
  /** the global pane keyboard lock (pane-deliver) */
  onPaneKeyboard<T>(f: () => Promise<T>): Promise<T>;
  sendKeys(paneId: string, keys: string): Promise<void>;
  send(ws: Sock, msg: unknown): void;
  broadcast(msg: unknown): void;
  broadcastSessions(): void;
  log(event: string, fields: Record<string, unknown>): void;
};

let deps: SessionVerbDeps | null = null;
export function initSessionVerbs(d: SessionVerbDeps): void {
  deps = d;
}
const D = (): SessionVerbDeps => {
  if (!deps) throw new Error("session-verbs not initialised");
  return deps;
};

/* COMPACT THIS SESSION'S CONTEXT, and it is a keystroke like every other.
 *
 * `/compact` goes through deliverToPane, not a raw sendText, for the reason
 * that function exists: a pane sitting on a permission prompt swallows the text
 * and answers the prompt with the enter that follows. Sending a slash command
 * blind there would approve something nobody looked at.
 *
 * THE RESULT GOES BACK. Compacting cannot be undone, so the app draws a
 * confirmation before asking for it -- and a confirmation that says "compacting"
 * over a pane where nothing was typed is the same lie in a new place. The frame
 * carries the refusal's own sentence, which already names the question the pane
 * is stuck on. */
/* THE SHARED BODY, one store of "compact this session". Two callers now: the ws
 * `compact` frame below and the ctx plugin's `compact` rpc op (#590). Returns the
 * result rather than sending it, so each caller wraps it in its own reply. The
 * tell is the sentence the app shows as a toast, ok and refusal alike -- the
 * refusal names the permission prompt the pane is stuck on. */
export async function compactSession(id: string): Promise<{ ok: boolean; tell: string }> {
  const d = D();
  const s = d.sessionOf(id);
  if (!s || !s.viaMux || !s.alive) {
    return { ok: false, tell: "that session is not running, so nothing was compacted" };
  }
  /* /compact IS A CLAUDE SLASH COMMAND (#587). Typing it into an agent that has no
   * such command types six visible characters into its prompt and submits them,
   * which is worse than doing nothing. Only an agent whose reader carries a launch
   * command is one this engine drives that way today (claude); refuse for the rest
   * by name, in the same {ok, tell} shape the ctx plugin and the ws frame both read. */
  if (!d.launchCommand(s.agent.id)) {
    return { ok: false, tell: `compacting from here is not supported for ${s.agent.name} yet` };
  }
  try {
    await d.deliverToPane(s.muxHandle, "/compact");
    return { ok: true, tell: "compacting this context" };
  } catch (e) {
    console.error(`[compact] ${id}:`, e);
    return {
      ok: false,
      tell: d.paneNotReadyTell(e) ??
        "(not compacted: /compact could not be typed into that pane)",
    };
  }
}

/* RETIRE NEXT RELEASE (#590): the ctx plugin's `compact` rpc op is the app's path
 * now; this ws frame delegates to the same compactSession for one release so an
 * un-updated client keeps working. A follow-up hygiene lane deletes this handler
 * and the compact-result frame once the new app release is everywhere. */
export function onCompact(ws: Sock, m: any) {
  const id = String(m.id ?? "");
  compactSession(id).then(({ ok, tell }) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: "compact-result", id, ok, tell }));
  });
}

export function onInterrupt(m: any) {
  const d = D();
  const s = d.sessionOf(String(m.id ?? ""));
  if (!s || !s.viaMux || !s.alive) return;
  /* NOTHING IS FORGOTTEN HERE, ON PURPOSE.
   *
   * This used to clear the note, on the belief that ctrl+c empties the input.
   * Measured: on a BUSY pane the first ctrl+c is eaten by the interrupt and the
   * body survives in the box, so clearing the note made the retry type a second
   * copy onto it -- the doubling the note exists to prevent. On an idle pane it
   * does empty in one press, and the read in deliverToPane sees that for itself.
   *
   * Either way the pane is the authority. Two mechanisms answering one question
   * is how a bug hides in the disagreement between them. */
  d.interrupt(s.muxHandle).catch((e) => {
    console.error(`[interrupt] ${s.id}:`, e);
  });
}

/* ANSWERING THE QUESTION A SESSION IS STOPPED ON.
 *
 * The one rule this whole path exists to keep: A KEY IS NEVER PRESSED ON A
 * SCREEN NOBODY JUST LOOKED AT. The app's buttons were drawn from a read that
 * could be seconds old, and in those seconds the prompt can be answered at the
 * keyboard, time out, or be replaced by the NEXT prompt from the same tool. So
 * the answer carries the fingerprint of the question it was drawn from, the
 * pane is re-read here, and a mismatch refuses rather than presses. MEASURED
 * consequence of getting that wrong: a digit sent to a pane that is no longer
 * asking anything lands as literal text in the input box, where it sits
 * unsubmitted and prefixes whatever he types next.
 *
 * And then it CHECKS. After the keystroke the pane is read again: if the same
 * question is still there, the answer did not take and the app is told so,
 * rather than being left showing a chat that looks answered.
 *
 * Nothing here has a default. There is no "just say yes", no retry that
 * escalates, no auto-answer on any timer. A destructive permission prompt is
 * answered by him or it is not answered.
 */
/* How long the terminal gets to redraw before we look to see whether the answer
 * landed. Real time by nature: it is a TUI repainting, not a timer this engine
 * owns, so there is no logical clock to advance. Read from the environment on
 * every use for the same reason the delivery timings are (adapters/
 * mux-adapter.ts): a module const is fixed by the import that loaded this file,
 * which in a test is the test file's own first line. Production sets nothing and
 * waits the shipped 900ms every time. */
const ANSWER_VERIFY_MS = (): number => Number(process.env.CYC_ANSWER_VERIFY_MS) || 900;

export async function onAnswer(ws: Sock, m: any) {
  const id = String(m.id ?? "");
  const fingerprint = String(m.fingerprint ?? "");
  const choice = Number(m.choice);
  const text = typeof m.text === "string" ? m.text.trim() : "";
  const d = D();
  const done = (ok: boolean, reason?: string, detail?: string) => {
    d.send(ws, { t: "answer-result", id, ok, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
    d.log("answer.result", { session: id, ok, reason, choice, chars: text.length });
  };

  const s = d.sessionOf(id);
  if (!s || !s.viaMux || !s.alive) return done(false, "gone", "That session is not running any more.");
  if (!Number.isInteger(choice) || choice < 1) return done(false, "bad-choice");
  /* Choices are answered by pressing their digit -- measured: the digit both
   * moves the selection and confirms it. Past nine there is no digit to press
   * and arrowing there is untested, so it is refused rather than guessed. */
  if (choice > 9) return done(false, "unreachable", "That option cannot be pressed from here.");

  const state = await readAskNow(s.muxHandle);
  if (!state.ok) return done(false, "unreadable", "Could not read that session's screen.");
  const ask = state.ask;
  if (!ask) return done(false, "vanished", "That question is gone; the session has moved on.");
  if (ask.fingerprint !== fingerprint) {
    return done(false, "changed", "The session is asking something else now.");
  }
  const picked = ask.choices.find((c) => c.n === choice);
  if (!picked) return done(false, "bad-choice");

  /* A CHOICE THAT OPENS A TEXT FIELD IS NOT ANSWERED FROM HERE, and nothing is
   * pressed for one.
   *
   * Selecting it is easy and typing into it is easy; SUBMITTING it is the part
   * that would not settle under measurement (see blocked.ts for the three runs
   * that disagreed). Pressing the digit and stopping would leave the terminal
   * sitting in an open text field, which is a worse place than it was, so this
   * refuses before it touches anything and says why. The choice still SHOWS in
   * the app -- hiding an option would misrepresent what the terminal is
   * offering -- it simply is not one this build can complete. */
  if (picked.freeText) {
    return done(false, "needs-terminal",
      "That option opens a text field in the terminal, and this app cannot finish one yet.");
  }
  if (text) return done(false, "not-free-text", "That option does not take a written answer.");

  d.log("answer.send", { session: id, choice, label: picked.label, fingerprint });
  /* THE CHECK AND THE KEYSTROKE HAPPEN INSIDE THE SAME LOCK.
   *
   * The check above is the fast one, so a question that is obviously gone gets
   * refused without waiting behind anything. It is NOT the one the press
   * depends on: the pane keyboard is a single global queue shared with message
   * delivery, and every message ahead of this one holds it for at least the
   * settle between its text and its enter. That gap is unbounded, and it is
   * exactly the window in which the prompt on screen becomes a different
   * prompt. So the last look happens with the queue already held, microseconds
   * before the key goes out, and nothing can slip between them. */
  /* Held in an object, not a bare `let`. The verdict is only ever assigned
   * inside the callback below, and TypeScript's flow analysis does not follow
   * an assignment made in a nested closure: it kept narrowing the variable to
   * its initialiser, so all three reads below were "these types have no
   * overlap". A property read is re-widened after an intervening call, which
   * is exactly what `await d.onPaneKeyboard(...)` is. */
  const v: { verdict: "sent" | "vanished" | "changed" | "unreadable" } = { verdict: "sent" };
  try {
    await d.onPaneKeyboard(async () => {
      const now = await readAskNow(s.muxHandle);
      if (!now.ok) { v.verdict = "unreadable"; return; }
      if (!now.ask) { v.verdict = "vanished"; return; }
      if (now.ask.fingerprint !== fingerprint) { v.verdict = "changed"; return; }
      await d.sendKeys(s.muxHandle, String(choice));
    });
  } catch (e) {
    console.error(`[answer] ${id}:`, e);
    return done(false, "send-failed", "The keystroke did not reach the terminal.");
  }
  if (v.verdict === "unreadable") return done(false, "unreadable", "Could not read that session's screen.");
  if (v.verdict === "vanished") return done(false, "vanished", "That question is gone; the session has moved on.");
  if (v.verdict === "changed") return done(false, "changed", "The session is asking something else now.");

  await new Promise((r) => setTimeout(r, ANSWER_VERIFY_MS()));
  const after = await readAskNow(s.muxHandle);
  /* A CHECK THAT COULD NOT BE MADE IS NOT A CHECK THAT PASSED.
   *
   * `after.ok === false` is an rpc that failed or a screen that came back
   * truncated, and it used to fall straight through to the success path below:
   * `↩ <label>` went into his transcript and `ok:true` went out to the phone,
   * while the very same read left `asks` holding ok:false -- so the panel said
   * it could not read the session directly above a chat line saying the choice
   * had been made. Two things that cannot both be true, on one screen, which is
   * this project's named defect.
   *
   * We know the keystroke left here and we know nothing after that, so that is
   * exactly what is said: no transcript line, because a line claims the choice
   * landed, and a detail that separates the send from the outcome rather than
   * implying nothing happened. */
  if (!after.ok) {
    return done(false, "unconfirmed",
      "The key was sent, but this session's screen could not be read to check it landed.");
  }
  if (after.ask && after.ask.fingerprint === fingerprint) {
    return done(false, "no-effect", "The session is still asking the same thing.");
  }

  /* The record of the decision, in the transcript, as one of his messages.
   *
   * Without it the chat shows a question that stopped being there and no sign
   * of who answered it or how, which is the same "the app knows something it
   * will not say" failure the whole idea is about. */
  const line = `${CONTROL_ANSWER_PREFIX}${picked.label}`;
  const ts = stampTs(s);
  const answered: ChatMsg = { id: s.id, role: "user", text: line, ts };
  logChat(s, answered);
  d.broadcast({ t: "chat", ...answered });
  d.broadcastSessions();
  done(true);
}

