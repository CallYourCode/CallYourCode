import { test, expect } from "bun:test";
import { REC_TEXT_CAP } from "./sessionrec";
import { BODY_CAP } from "../sessions/session-events";

/* THE 09-09 INCIDENT, made into a guard.
 *
 * The extractor's per-body cap (BODY_CAP, sessions/session-events.ts) was
 * raised while the log writer's safety net (REC_TEXT_CAP, chat/sessionrec.ts)
 * silently stayed at 2000, so stored ticks were truncated below what the app
 * would then try to show. The invariant: the writer must store at least as much
 * as the extractor will show, i.e. REC_TEXT_CAP >= BODY_CAP.
 *
 * The two modules do not import each other (sessionrec is a zero-import leaf,
 * and the extractor touches the fs), so this test is the only thing tying the
 * two literals together. It runs in every full suite. */
test("the log writer's cap is never below the extractor's body cap (09-09)", () => {
  expect(REC_TEXT_CAP).toBeGreaterThanOrEqual(BODY_CAP);
});
