import { expect, test } from "bun:test";
import { nativeLaunch } from "./native-launch.ts";
import { claudeReader } from "../readers/claude.ts";
import { codexReader } from "../readers/codex.ts";
import { opencodeReader } from "../readers/opencode.ts";
import { piReader } from "../readers/pi.ts";
import { augmentPiLaunch } from "./pi-launch.ts";
import { withAgentEnv } from "../runtime/agent-env.ts";

const sid = "11111111-1111-4111-8111-111111111111";
const aid = "ag-0123456789abcdef";
for (const reader of [claudeReader, codexReader, opencodeReader, piReader]) {
  test(`${reader.tag}: native resume uses the reader's exact session, never newest-in-cwd`, () => {
    const sessionId = reader.tag === "opencode" ? "ses_0123456789abcdef" : sid;
    const command = reader.launch!.resume(sessionId);
    const got = nativeLaunch(withAgentEnv(command, aid));
    expect(got.kind).toBe(reader.tag);
    expect(got.args).toContain(sessionId);
    if (reader.tag === "pi") expect(got.args).not.toContain("-c");
    expect(got.args).not.toContain("--continue");
    if (reader.tag === "codex") expect(got.args[0]).toBe("resume");
    if (reader.tag === "claude") expect(got.args).toContain("--dangerously-skip-permissions");
    if (reader.tag === "opencode") expect(got.args).toContain("--auto");
  });
}
test("pi keeps the SAME reopen extension, socket and stable agent context across argv-only start", () => {
  const command = augmentPiLaunch(withAgentEnv(piReader.launch!.resume(sid), aid), {
    extensionPath: "/engine/with space/cyc-output.js", sockPath: "/tmp/events.sock",
  }).command;
  expect(nativeLaunch(command)).toEqual({ kind: "pi", args: ["--session", sid, "-e", "/engine/with space/cyc-output.js",
    "--cyc-agent-id", aid, "--cyc-event-sock", "/tmp/events.sock"] });
});
test("native launch never evaluates shell syntax", () => {
  expect(() => nativeLaunch("pi --session x; echo bad")).toThrow();
  expect(() => nativeLaunch("pi 'unterminated")).toThrow();
});
