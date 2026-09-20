/* THE TMUX JSONL-LINKING IDENTITY STEP, unit tests (design Gap 2).
 *
 * The birth-floor / 571-refusal / sticky-handover / ambiguity-degrade rules used
 * to live inside terminal/tmux.ts and were provable only end to end against a
 * real tmux server (terminal/tmux.test.ts). They moved behind the identity
 * layer as a PURE function (sessions/tmux-link.ts:linkPane) and a thin stateful
 * driver (TmuxLinker), so the same rules are now unit-testable on raw facts
 * alone. terminal/tmux.test.ts still proves the real-tmux OBSERVATION feeds this
 * function correctly; here we prove the DECISION the function makes, which is
 * where the folder-collision / uuid-rollover bugs actually lived.
 *
 *   bun test agent-engine/src/sessions/tmux-link.test.ts
 */

import { test, expect } from "bun:test";
import { linkPane, TmuxLinker, type TmuxLinkFacts, type TmuxLinkState } from "./tmux-link.ts";
import { ANNOUNCED_SOURCE, PARKED_SOURCE, PREMINT_SOURCE, type AgentSessionRef } from "../runtime/agents.ts";

const NOW = 1_000_000;
const HANDLE = "%1~4242~7";

/** A raw fact bundle for a hand-started claude pane present at the first
 *  enumeration (the restart shape: no floor), overridable per case. */
function facts(over: Partial<TmuxLinkFacts> = {}): TmuxLinkFacts {
  return {
    handle: HANDLE, agent: "claude", cwd: "/home/x/proj",
    announced: null, candidate: null, premint: null, spawnAt: null,
    firstSeenAt: null, presentAtFirstEnum: true, ...over,
  };
}
function candidate(id: string, bornAt: number | null): TmuxLinkFacts["candidate"] {
  return { sessionId: id, path: `/p/${id}.jsonl`, bornAt };
}
const premintRef = (id: string): AgentSessionRef => ({ id, kind: "id", source: PREMINT_SOURCE });

/* ------------------------------------------------ (i) the announce override */

test("an announce overrides the premint, the guess and any established link, with no floor", () => {
  // an established link AND a fresh guess both present; the announce still wins
  const prior: TmuxLinkState = { linked: { id: "old-linked", bornAt: NOW } };
  const f = facts({
    announced: { sessionId: "ANNOUNCED" },
    candidate: candidate("guess", NOW + 1000),
    premint: premintRef("ag-premint00000001"),
  });
  const { ref, state } = linkPane(f, prior, NOW, false);
  expect(ref).toEqual({ id: "ANNOUNCED", kind: "id", source: ANNOUNCED_SOURCE });
  expect(state, "the guess is retired for an announced pane").toBeUndefined();
});

test("an announce carries the harness's link (fork/resume) through unchanged", () => {
  const { ref } = linkPane(
    facts({ announced: { sessionId: "S", link: { kind: "fork", from: "F" } } }), undefined, NOW, false);
  expect(ref).toEqual({ id: "S", kind: "id", source: ANNOUNCED_SOURCE, link: { kind: "fork", from: "F" } });
});

test("a NON-CLAUDE announce (codex, opencode) binds through the same override, dropping state", () => {
  // codex notify / the opencode plugin announce their own id; linkPane is
  // agent-agnostic for the announce branch, so the announced id wins and the
  // guess is retired for the pane, exactly as it does for claude.
  for (const [agent, id] of [["codex", "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"],
                             ["opencode", "ses_fdb060bd7ffe5FdHc7yVVdct3p"]] as const) {
    const prior: TmuxLinkState = { linked: { id: "old-linked", bornAt: NOW } };
    const f = facts({ agent, announced: { sessionId: id }, candidate: candidate("guess", NOW + 1000) });
    const { ref, state } = linkPane(f, prior, NOW, false);
    expect(ref, agent).toEqual({ id, kind: "id", source: ANNOUNCED_SOURCE });
    expect(state, `${agent}: the guess is retired for an announced pane`).toBeUndefined();
  }
});

/* --------------------------------------------------- (ii) the folder guess */

test("a pane present at the first enumeration takes the newest jsonl with no floor (restart rule)", () => {
  const { ref, state } = linkPane(facts({ candidate: candidate("S1", NOW - 999_999) }), undefined, NOW, false);
  expect(ref).toEqual({ id: "S1", kind: "id", source: "tmux:claude" });
  expect(state?.linked).toEqual({ id: "S1", bornAt: NOW - 999_999 });
});

test("the ambiguous same-cwd case degrades to null: two panes cannot be told apart", () => {
  const { ref } = linkPane(facts({ candidate: candidate("S1", NOW) }), undefined, NOW, /*ambiguous*/ true);
  expect(ref).toBeNull();
});

test("a non-claude pane is never folder-guessed and never parked", () => {
  // both non-claude harnesses: with no announce and a candidate, the folder
  // guess stays claude-only (tmux-link.ts:112-115), so they return null.
  for (const agent of ["codex", "opencode"]) {
    const { ref } = linkPane(facts({ agent, candidate: candidate("S1", NOW) }), undefined, NOW, false);
    expect(ref, agent).toBeNull();
  }
});

/* --------------------------------------------- (v) the parked hand-started */

test("a hand-started claude with no transcript parks on its handle", () => {
  const { ref } = linkPane(facts({ candidate: null }), undefined, NOW, false);
  expect(ref).toEqual({ id: HANDLE, kind: "id", source: PARKED_SOURCE });
});

test("the first-seen floor refuses a pre-existing stranger, then adopts the pane's own newborn", () => {
  // a pane that appeared MID-RUN (not present at first enum) floors on first-seen
  const firstSeenAt = NOW;
  const strangerBornBefore = candidate("stranger", NOW - 60_000);
  const parked = facts({ presentAtFirstEnum: false, firstSeenAt, candidate: strangerBornBefore });

  // the stranger predates first-seen: refused, the pane stays parked
  const logs: string[] = [];
  let r = linkPane(parked, undefined, NOW, false, (l) => logs.push(l));
  expect(r.ref).toEqual({ id: HANDLE, kind: "id", source: PARKED_SOURCE });
  expect(logs.some((l) => l.includes("predates first-seen"))).toBe(true);

  // the same refusal on the next poll does NOT log again (once per pane+jsonl)
  logs.length = 0;
  r = linkPane(parked, r.state, NOW, false, (l) => logs.push(l));
  expect(r.ref?.source).toBe(PARKED_SOURCE);
  expect(logs, "the 571 refusal is logged once, not per poll").toEqual([]);

  // the pane's OWN transcript, born after first-seen, clears the floor
  const ownBornAfter = facts({ presentAtFirstEnum: false, firstSeenAt, candidate: candidate("own", NOW + 20) });
  r = linkPane(ownBornAfter, r.state, NOW, false, (l) => logs.push(l));
  expect(r.ref).toEqual({ id: "own", kind: "id", source: "tmux:claude" });
  expect(logs.some((l) => l.includes("handover parked -> own"))).toBe(true);
});

/* ------------------------------------------------- the engine-spawn premint */

test("the premint carries until a post-spawn transcript supersedes it; a pre-spawn stranger is refused", () => {
  const spawnAt = NOW;
  const ag = "ag-premint00000001";
  // no transcript yet: the premint ref is the pane's identity
  let r = linkPane(facts({ premint: premintRef(ag), spawnAt, candidate: null, presentAtFirstEnum: false }),
    undefined, NOW, false);
  expect(r.ref).toEqual(premintRef(ag));

  // a stranger born BEFORE the spawn is refused; the premint holds
  r = linkPane(facts({ premint: premintRef(ag), spawnAt, presentAtFirstEnum: false,
    candidate: candidate("stranger", NOW - 30_000) }), r.state, NOW, false);
  expect(r.ref).toEqual(premintRef(ag));

  // the pane's own jsonl, born after the spawn, supersedes the premint
  r = linkPane(facts({ premint: premintRef(ag), spawnAt, presentAtFirstEnum: false,
    candidate: candidate("own", NOW + 10) }), r.state, NOW, false);
  expect(r.ref).toEqual({ id: "own", kind: "id", source: "tmux:claude" });
});

/* ----------------------------------------- (iii) the sticky established link */

test("an established link is held against a busier OLDER-born neighbour; only a later-born jsonl takes over", () => {
  // linked to `own`, born at NOW
  const linked: TmuxLinkState = { linked: { id: "own", bornAt: NOW } };

  // the busy neighbour is now the newest by mtime, but born BEFORE the link:
  // it is refused and the established link holds
  let r = linkPane(facts({ presentAtFirstEnum: false, firstSeenAt: NOW - 100,
    candidate: candidate("neighbour", NOW - 120_000) }), linked, NOW, false);
  expect(r.ref).toEqual({ id: "own", kind: "id", source: "tmux:claude" });
  expect(r.state?.linked).toEqual({ id: "own", bornAt: NOW });

  // a genuine roll writes a FRESH jsonl, born after the link: handover follows
  r = linkPane(facts({ presentAtFirstEnum: false, firstSeenAt: NOW - 100,
    candidate: candidate("rolled", NOW + 5) }), r.state, NOW, false);
  expect(r.ref).toEqual({ id: "rolled", kind: "id", source: "tmux:claude" });
  expect(r.state?.linked).toEqual({ id: "rolled", bornAt: NOW + 5 });
});

test("a candidate whose birth cannot be read is refused under a floor, kept as the fallback born", () => {
  // under a floor, a null birth is a refusal (cannot prove it cleared the floor)
  const r = linkPane(facts({ presentAtFirstEnum: false, firstSeenAt: NOW,
    candidate: candidate("unstattable", null) }), undefined, NOW, false);
  expect(r.ref?.source).toBe(PARKED_SOURCE);

  // with NO floor (present at first enum), a null birth still links, stored as `now`
  const r2 = linkPane(facts({ candidate: candidate("first", null) }), undefined, NOW, false);
  expect(r2.ref).toEqual({ id: "first", kind: "id", source: "tmux:claude" });
  expect(r2.state?.linked).toEqual({ id: "first", bornAt: NOW });
});

/* ----------------------------------------------------- the stateful driver */

test("TmuxLinker keeps per-handle state, computes same-cwd ambiguity, and prunes gone panes", () => {
  const linker = new TmuxLinker();
  const cwd = "/home/x/proj";
  const A = "%1~11~7", B = "%2~22~7";

  // TWO claude panes appear together in one cwd: neither can be told apart by
  // "newest", so BOTH degrade to null (never a wrong guess)
  let out = linker.resolve([
    facts({ handle: A, cwd, candidate: candidate("S1", NOW) }),
    facts({ handle: B, cwd, candidate: candidate("S1", NOW) }),
  ], NOW);
  expect(out.get(A)).toBeNull();
  expect(out.get(B)).toBeNull();

  // B leaves; A is alone again, no longer ambiguous, and links (its state was
  // pruned while it appeared to leave, but it never had one to begin with)
  out = linker.resolve([facts({ handle: A, candidate: candidate("S2", NOW + 1) })], NOW);
  expect(out.get(A)).toEqual({ id: "S2", kind: "id", source: "tmux:claude" });
});
