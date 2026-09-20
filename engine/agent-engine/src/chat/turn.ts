/* How long a session has been in its current state, the value the row's
 * subtitle renders as an age ("3m", "1h"). herdr does not report it, so the
 * engine stamps the instant a stretch begins and lets the row tick the elapsed
 * time itself -- nothing has to be pushed per minute.
 *
 * Extracted from server.ts so the boot behaviour can be tested without booting
 * the server (server.ts opens a socket on import). The rule that matters lives
 * in turnSinceFor: a RESTART must not reset every row's age.
 *
 *   working and blocked are one stretch ("busy since"), idle and done another
 *   ("waiting since"), because flipping between done and idle is bookkeeping
 *   rather than something that happened.
 */

/** Only status matters; typed structurally so this module never imports Session. */
export type TurnPrev = { status?: string; turnSince?: number };

export function turnPhase(status: string | undefined): string {
  return status === "working" || status === "blocked" ? "busy" : "waiting";
}

/* When the current stretch began, epoch ms.
 *
 * `prev` is the same session as observed on the previous herdr poll, in this
 * process. It is UNDEFINED on the first poll after an engine restart -- and the
 * old code returned Date.now() there, so every restored session's stretch
 * looked like it had begun at the process's start. Right after a deploy every
 * row read "<1m", and sixteen minutes later every row read the restart age
 * (#411): the list stopped telling the truth about when anything last happened.
 *
 * The stretch did not begin at boot; the on-disk proxy for when this session
 * last did anything is its newest stored message (`restoredLastTs`, from
 * chat.json). Seed from that across a restart, and only fall back to now for a
 * session with no history at all -- a genuinely new turn that does begin now.
 *
 * `now` is injectable so a test can pin "now" without touching the clock. */
export function turnSinceFor(
  prev: TurnPrev | undefined,
  status: string,
  restoredLastTs?: number,
  now: () => number = Date.now,
): number {
  if (!prev) return restoredLastTs ?? now();
  if (turnPhase(prev.status) !== turnPhase(status)) return now();
  return prev.turnSince || now();
}
