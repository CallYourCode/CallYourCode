/* THE STATUS REDUCER TABLE (fix STATUSREDUCER).
 *
 * Exhaustive coverage of the one precedence table both merge points now share
 * (status-reducer.ts): every mux cell (hint x carried jsonl verdict x
 * nativeDone), every transcript edge (dedupe, blocked no-op is a caller guard
 * but the record-only rule is here, idle-keeps-mux-done), the outlive-the-poll
 * sequence, the rotation/blocked carry drop, and deriveBusy over all four
 * status values x alive/dead.
 *
 * PURE UNIT: no session-state, no data dir, just the reducer function. The
 * equivalence proof that it matches the shipped reconcile + applyJsonlStatus
 * lives in the existing green suites (turn-age, done-synth, pi-ingest, ingest);
 * this is the table itself, asserted rule by rule.
 *
 *   bun test agent-engine/src/sessions/status-reducer.test.ts
 */

import { expect, test, describe } from "bun:test";
import { reduceStatus, deriveBusy, type JsonlStatus, type StatusState } from "./status-reducer.ts";
import type { AgentStatus } from "../terminal/mux.ts";

const mux = (hint: AgentStatus, nativeDone: boolean, rotated = false) =>
  ({ source: "mux", hint, nativeDone, rotated }) as const;
const txt = (edge: "working" | "idle") => ({ source: "transcript", edge }) as const;
const st = (status: AgentStatus, jsonlStatus: JsonlStatus): StatusState => ({ status, jsonlStatus });

describe("mux observation: hint x carried jsonl verdict x nativeDone", () => {
  // The carried verdict values the reducer reads (a permission dialog never
  // reaches the jsonl, so it is only ever working/idle/undefined).
  const carries: JsonlStatus[] = ["working", "idle", undefined];
  // Every hint herdr can report; tmux only ever reports idle/blocked but the
  // table is defined over the whole set.
  const hints: AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

  // The table VERBATIM, as an independent oracle (not the code under test).
  const oracle = (hint: AgentStatus, carry: JsonlStatus, nativeDone: boolean): { status: AgentStatus; jsonlStatus: JsonlStatus } => {
    const jsonlStatus: JsonlStatus = hint === "blocked" ? undefined : carry;
    const synthDone = !nativeDone && jsonlStatus === "idle" && hint !== "blocked";
    const status: AgentStatus = hint === "blocked" ? "blocked"
      : jsonlStatus === "working" ? "working"
      : jsonlStatus === "idle" && hint === "working" ? "idle"
      : synthDone ? "done"
      : hint;
    return { status, jsonlStatus };
  };

  for (const nativeDone of [true, false]) {
    for (const hint of hints) {
      for (const carry of carries) {
        test(`hint=${hint} carry=${carry ?? "none"} nativeDone=${nativeDone}`, () => {
          // prev.status is unused by the mux rule; feed a distinct value to
          // prove that (any carried status must not leak into the mux verdict).
          const r = reduceStatus(st("done", carry), mux(hint, nativeDone));
          const want = oracle(hint, carry, nativeDone);
          expect(r.status).toBe(want.status);
          expect(r.jsonlStatus ?? null).toBe(want.jsonlStatus ?? null);
          expect(r.changed).toBe(want.status !== "done");
        });
      }
    }
  }

  test("blocked always wins and drops the carry, even over a jsonl working", () => {
    const r = reduceStatus(st("working", "working"), mux("blocked", false));
    expect(r.status).toBe("blocked");
    expect(r.jsonlStatus).toBeUndefined();
  });

  test("jsonl working reopens over herdr's stale idle (the thinking-7m guard)", () => {
    const r = reduceStatus(st("idle", "working"), mux("idle", true));
    expect(r.status).toBe("working");
    expect(r.jsonlStatus).toBe("working");
  });

  test("jsonl idle closes herdr's phantom working -> idle", () => {
    const r = reduceStatus(st("working", "idle"), mux("working", true));
    expect(r.status).toBe("idle");
  });

  test("jsonl idle keeps herdr's richer done (native done stands, no synth)", () => {
    const r = reduceStatus(st("done", "idle"), mux("done", true));
    expect(r.status).toBe("done"); // hint passes through, not overridden to idle
  });

  test("tmux synthesizes done from a closed jsonl turn (nativeDone false)", () => {
    const r = reduceStatus(st("idle", "idle"), mux("idle", false));
    expect(r.status).toBe("done");
  });

  test("herdr does NOT synthesize done from the same closed turn (nativeDone true)", () => {
    const r = reduceStatus(st("idle", "idle"), mux("idle", true));
    expect(r.status).toBe("idle");
  });
});

describe("mux observation: rotation drops the carry", () => {
  test("a rotated session ignores the old file's verdict", () => {
    // without rotation a jsonl working would stamp working...
    expect(reduceStatus(st("idle", "working"), mux("idle", true, false)).status).toBe("working");
    // ...rotated, the carry belongs to the old file and is dropped, so the
    // hint stands and the new carry is undefined.
    const r = reduceStatus(st("idle", "working"), mux("idle", true, true));
    expect(r.status).toBe("idle");
    expect(r.jsonlStatus).toBeUndefined();
  });

  test("rotation drops a would-be tmux done synth too", () => {
    const r = reduceStatus(st("idle", "idle"), mux("idle", false, true));
    expect(r.status).toBe("idle"); // carry dropped, no synth
    expect(r.jsonlStatus).toBeUndefined();
  });
});

describe("transcript observation", () => {
  test("dedupe: the carry already says this -> no change, no carry churn", () => {
    const r = reduceStatus(st("working", "working"), txt("working"));
    expect(r.changed).toBe(false);
    expect(r.status).toBe("working");
    expect(r.jsonlStatus).toBe("working");
  });

  test("idle edge while the row is not working: record only, keep the mux value", () => {
    // the row shows herdr's done; an idle edge records the verdict but does not
    // move the row (changed false) and does not clobber done.
    const r = reduceStatus(st("done", undefined), txt("idle"));
    expect(r.changed).toBe(false);
    expect(r.status).toBe("done"); // the mux's richer idle/done kept
    expect(r.jsonlStatus).toBe("idle"); // still recorded (the carry)
  });

  test("idle edge while working closes the turn -> idle, changed", () => {
    const r = reduceStatus(st("working", "working"), txt("idle"));
    expect(r.changed).toBe(true);
    expect(r.status).toBe("idle");
    expect(r.jsonlStatus).toBe("idle");
  });

  test("working edge opens the turn -> working, changed", () => {
    const r = reduceStatus(st("idle", "idle"), txt("working"));
    expect(r.changed).toBe(true);
    expect(r.status).toBe("working");
    expect(r.jsonlStatus).toBe("working");
  });

  test("working edge while already working (carry stale) still records, changed", () => {
    // status working but carry not yet working (e.g. mux drove working): the
    // edge is not a dedupe, the record-only guard is for idle only, so it takes
    // the full path (matches applyJsonlStatus: from===edge just skips the log).
    const r = reduceStatus(st("working", undefined), txt("working"));
    expect(r.changed).toBe(true);
    expect(r.status).toBe("working");
    expect(r.jsonlStatus).toBe("working");
  });

  test("idle edge while idle (carry stale) records only", () => {
    const r = reduceStatus(st("idle", undefined), txt("idle"));
    expect(r.changed).toBe(false);
    expect(r.status).toBe("idle");
    expect(r.jsonlStatus).toBe("idle");
  });
});

describe("the outlive-the-poll sequence", () => {
  test("a jsonl idle survives the next mux working hint", () => {
    // the transcript closes the turn: record idle on the carry
    let s = reduceStatus(st("working", "working"), txt("idle"));
    expect(s.status).toBe("idle");
    expect(s.jsonlStatus).toBe("idle");
    // the next rebuild: herdr reports its phantom working; the carried idle
    // holds the row at idle rather than reopening the turn.
    const r = reduceStatus(st(s.status, s.jsonlStatus), mux("working", true));
    expect(r.status).toBe("idle");
  });

  test("a jsonl working survives the next mux idle hint", () => {
    let s = reduceStatus(st("idle", "idle"), txt("working"));
    expect(s.jsonlStatus).toBe("working");
    const r = reduceStatus(st(s.status, s.jsonlStatus), mux("idle", true));
    expect(r.status).toBe("working"); // stale idle does not stamp back
  });
});

describe("deriveBusy: all four status values x alive/dead", () => {
  const cases: [AgentStatus, boolean][] = [
    ["working", true], ["blocked", true], ["idle", true], ["done", true], ["unknown", true],
    ["working", false], ["blocked", false], ["idle", false], ["done", false], ["unknown", false],
  ];
  for (const [status, alive] of cases) {
    const want = alive && (status === "working" || status === "blocked");
    test(`${status} alive=${alive} -> ${want}`, () => {
      expect(deriveBusy(status, alive)).toBe(want);
    });
  }

  test("a dead pane is never busy, whatever the status", () => {
    expect(deriveBusy("working", false)).toBe(false);
    expect(deriveBusy("blocked", false)).toBe(false);
  });
});
