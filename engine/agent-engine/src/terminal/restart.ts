/* WHAT A RESTART IS ALLOWED TO CLAIM.
 *
 * The route that quits an agent and types the command again lives in server.ts.
 * What it is entitled to SAY afterwards lives here, on its own, because the
 * first version of it got that wrong in the way this codebase keeps getting it
 * wrong: it answered `ok` on the strength of having sent the command.
 *
 * Two separate mistakes produced one sentence:
 *
 *   1. The watch loop returned as soon as herdr listed a process on the pane.
 *      A process existing is not a session; `claude --resume <id>` for a
 *      conversation this machine does not have IS a process, for about a
 *      second, and then it prints "No conversation found with session ID" and
 *      drops back to the shell. The loop had already returned "(Restarted,
 *      resuming the previous conversation.)" and that sentence went into his
 *      chat log as a claude message.
 *   2. The route returned `{ok:true}` whatever the loop said, so even the
 *      honest "nothing has started yet" arrived at the app as a success.
 *
 * So: THE ONLY THINGS THAT CONFIRM A RESTART ARE THINGS DRAWN ON THE SCREEN.
 * claude's own input box (`ready`), or a dialog it is asking (`waiting`). Both
 * mean it got far enough to render. A process, a first byte and an elapsed
 * timer confirm nothing and are not consulted here at all.
 *
 * And there is a third outcome that is neither: we watched, the window ran out,
 * and we never saw claude. That is `nothing`, it is not a failure and it is not
 * a success, and it says so. `restartConfirmed` is false for it, which is what
 * stops the app calling it a restart.
 */

import type { BoxVerdict } from "./herdr.ts";

/** What the screen showed. Only `waiting` and `ready` were CLAUDE. */
export type RestartSighting =
  | { seen: "waiting"; question: string }
  | { seen: "ready" }
  | { seen: "no-session" }
  | { seen: "nothing" };

/** One read of the pane, as the watcher sees it. */
export type RestartRead = {
  kind: BoxVerdict;
  /** the chooser's question when `kind` is "chooser", otherwise null */
  question: string | null;
  /** the raw screen, for the one failure that announces itself in words */
  screen: string;
};

/* `claude --resume <id>` on a machine that has never held that conversation
 * exits with this on the shell. It is the reported symptom -- the pane said
 * there was no such conversation while the app said it had restarted -- and it
 * is the one restart failure that names itself, so it is read rather than
 * timed out. */
const NO_SESSION = /no conversation found/i;

/** What this read concludes, or null for "keep watching".
 *
 * ORDER MATTERS, and claude wins. If its box or its dialog is on the screen
 * then it is up, and the phrase can only be text inside a resumed
 * conversation. Only a screen with no claude on it is read for words. */
export function sightRestart(read: RestartRead): RestartSighting | null {
  if (read.kind === "chooser" && read.question) {
    return { seen: "waiting", question: read.question };
  }
  if (read.kind === "input") return { seen: "ready" };
  if (NO_SESSION.test(read.screen)) return { seen: "no-session" };
  /* `unknown` (a screen we read and did not recognise) and `unreadable` (a
   * screen we never got) are the same thing here: not claude, not yet. Neither
   * is conclusive, and neither may end the watch early. */
  return null;
}

/** THE PREDICATE. True only where something drawn said so. */
export function restartConfirmed(s: RestartSighting): boolean {
  return s.seen === "waiting" || s.seen === "ready";
}

/* WHAT MAY BECOME A MESSAGE IN HIS CHAT, which is a smaller set than what may
 * be said to the app.
 *
 * The route logs the sentence as a claude message, and that is right for
 * anything we watched happen: "it is waiting on a question in the terminal" is
 * exactly the line you want to find in the history a day later. It is wrong for
 * `nothing`. That verdict means we could not tell, it is reached by a window
 * running out, and it was landing a permanent "this cannot say whether it
 * restarted" in the log of sessions that had restarted perfectly well. A record
 * that outlives the doubt has to be about something observed; the app still
 * gets the sentence, as a toast he can dismiss. */
export function restartLogsToChat(s: RestartSighting): boolean {
  return s.seen !== "nothing";
}

/** The sentence, which is also what gets logged into his chat. Nothing here
 *  says "restarted" unless restartConfirmed() is true of the same value. */
export function restartTell(s: RestartSighting, mode: "fresh" | "resume"): string {
  switch (s.seen) {
    case "waiting":
      return `(Restarted. It is waiting on a question in the terminal: ` +
        `"${s.question}". Answer it here if the buttons appear, in the terminal if not.)`;
    case "ready":
      return mode === "resume"
        ? "(Restarted, resuming the previous conversation.)"
        : "(Restarted fresh. It remembers nothing of what came before.)";
    case "no-session":
      return "(Not restarted: the terminal says there is no such conversation on that " +
        "machine, so there was nothing to resume. Restart it fresh to start a new one.)";
    case "nothing":
      return "(The command was typed, but nothing recognisable has come up in the " +
        "terminal, so this cannot say whether it restarted. Open it to see.)";
  }
}

/* THE WATCH, with its reads and its clock handed in, so a test can drive it
 * without a pane.
 *
 * It ends on a SIGHTING or on the window running out, and never on the first
 * read: the first read happens a step in, and a screen that says nothing yet
 * says nothing yet. That is the whole change from the version that returned as
 * soon as herdr admitted to a process.
 *
 * The step comes BEFORE the read because the command has only just been typed
 * when this is entered; reading immediately reads the shell echoing it. */
export async function watchRestart(
  read: () => Promise<RestartRead>,
  opts: {
    windowMs: number;
    stepMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<RestartSighting> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + opts.windowMs;
  while (now() < until) {
    await sleep(opts.stepMs);
    const sighting = sightRestart(await read());
    if (sighting) return sighting;
  }
  return { seen: "nothing" };
}
