/* withAgentEnv: the launch-command prefix (cyc-cli plan section 3, section 8).
 *
 *   bun test agent-engine/src/runtime/agent-env.test.ts
 */

import { test, expect } from "bun:test";
import { withAgentEnv } from "./agent-env.ts";
import { mintAgentId } from "./agentmeta.ts";

test("prefixes the command with `env CYC_AGENT_ID=<id>`", () => {
  const aid = "ag-3fK9x2mPq81LbR0w";
  expect(withAgentEnv("claude --resume", aid)).toBe("env CYC_AGENT_ID=ag-3fK9x2mPq81LbR0w claude --resume");
});

test("the portable `env` form is used, not a bare shell assignment (fish parses it)", () => {
  const out = withAgentEnv("claude", "ag-3fK9x2mPq81LbR0w");
  expect(out.startsWith("env CYC_AGENT_ID=")).toBe(true);
  expect(out.startsWith("CYC_AGENT_ID=")).toBe(false);
});

test("a real minted id always passes the charset gate", () => {
  for (let i = 0; i < 200; i++) {
    const aid = mintAgentId();
    expect(() => withAgentEnv("claude", aid)).not.toThrow();
    expect(withAgentEnv("claude", aid)).toBe(`env CYC_AGENT_ID=${aid} claude`);
  }
});

test("a malformed id is refused BEFORE it reaches a command line", () => {
  for (const bad of [
    "",
    "ag-",
    "notanid",
    "ag-tooShort",
    "ag-3fK9x2mPq81LbR0w-extra",
    "ag-3fK9x2mPq81LbR0;rm -rf /", // a shell-injection attempt
    "ag-3fK9x2mPq81LbR0 ",         // trailing space
    "ag-3fK9x2mPq81LbR0\n",        // a newline
  ]) {
    expect(() => withAgentEnv("claude", bad), `accepted ${JSON.stringify(bad)}`).toThrow(/malformed agent id/);
  }
});
