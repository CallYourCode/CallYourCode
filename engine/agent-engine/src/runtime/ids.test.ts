/* The id grammars (ids.ts): what may name a conversation and what may not.
 *
 *   bun test src/runtime/ids.test.ts
 */

import { describe, test, expect } from "bun:test";
import { isHarnessSessionId, isPaneShapedId, isAgentId, ANNOUNCE_ID_RE, UUID_RE, SES_RE,
  HERDR_PANE_RE, TMUX_PANE_RE } from "./ids.ts";

const CLAUDE = "6f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718";
const CODEX = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"; // UUIDv7
const PI = "01a01059-2c50-729b-93ba-9e0c814a537b";
const OPENCODE = "ses_7f3a2b1c9d8e0f4a5b6c7d";
/* A real opencode session id read from the live db (ses_ + 26 alnum), the
 * restart-by-id contract's own fixture: it must name a conversation. */
const OPENCODE_REAL = "ses_fdb060bd7ffe5FdHc7yVVdct3p";
const AGENT = "ag-coHgn7cXRB2lw8_u";

/* The pane spellings seen in real metas (2026-09-02 survey of 110 records:
 * 57 current ids, 52 past ids and 2 lineage entries were pane ids) plus the
 * tmux and prefixed forms. */
const PANES = ["w1:p1", "w7:p1", "w9:p1G", "wD:p1", "w3:p1", "%3", "%12~4711~1700000000",
  "herdr:w3:p1", "tmux:%3", "tmux:%3~4711~1700000000"];

describe("isHarnessSessionId", () => {
  test("claude, codex and pi uuids of any version, and opencode ses_ ids, pass", () => {
    for (const id of [CLAUDE, CODEX, PI, OPENCODE, OPENCODE_REAL, CLAUDE.toUpperCase()]) expect(isHarnessSessionId(id), id).toBe(true);
  });
  test("every pane shape, the engine's agent id, labels and junk fail", () => {
    /* `ses_` + 19 alnum is one char short of SES_RE's 20-char floor: a ses_ id
     * that does not clear the grammar must not name a conversation. */
    const SES_19 = "ses_abcdefghij123456789";
    expect(SES_19.length - "ses_".length, "the short ses_ fixture is exactly 19 alnum").toBe(19);
    for (const bad of [...PANES, AGENT, "red:p1", "blue:p1", "s1", "cur-a", "never-announced",
        "%3~12~9", "w7:p1", SES_19,
        "", null, undefined, 42, "ses_short", `${CLAUDE}x`, ` ${CLAUDE}`]) {
      expect(isHarnessSessionId(bad), String(bad)).toBe(false);
    }
  });
});

describe("isPaneShapedId", () => {
  test("herdr w:p, tmux %N and %N~pid~epoch, bare or mux-prefixed", () => {
    for (const p of PANES) expect(isPaneShapedId(p), p).toBe(true);
  });
  test("harness ids, agent ids and labels are not pane-shaped", () => {
    for (const n of [CLAUDE, OPENCODE, AGENT, "s1", "red:p1", "", null, 7]) expect(isPaneShapedId(n), String(n)).toBe(false);
  });
});

describe("the grammars themselves", () => {
  test("UUID_RE and SES_RE are anchored; the pane grammars too", () => {
    expect(UUID_RE.test(`x${CLAUDE}`)).toBe(false);
    expect(SES_RE.test(`${OPENCODE}\n`)).toBe(false);
    expect(HERDR_PANE_RE.test("w1:p1")).toBe(true);
    expect(HERDR_PANE_RE.test("w1:p1:x")).toBe(false);
    expect(TMUX_PANE_RE.test("%3")).toBe(true);
    expect(TMUX_PANE_RE.test("%3~1~2")).toBe(true);
    expect(TMUX_PANE_RE.test("%3~1")).toBe(false);
  });
  test("isAgentId is the mint's shape", () => {
    expect(isAgentId(AGENT)).toBe(true);
    expect(isAgentId("ag-short")).toBe(false);
    expect(isAgentId(CLAUDE)).toBe(false);
  });
  test("the announce route's grammar admits every harness id and no pane id", () => {
    for (const id of [CLAUDE, CODEX, PI, OPENCODE]) expect(ANNOUNCE_ID_RE.test(id), id).toBe(true);
    for (const p of PANES) expect(ANNOUNCE_ID_RE.test(p), p).toBe(false);
  });
});
