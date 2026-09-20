/* pi-launch: the launch-command augmentation is ADDITIVE and pi-only. A pi
 * launch gains a CYC_PI_EVENT_SOCK env and a `-e <ext>` flag; every other
 * harness comes back byte-identical.
 *
 *   bun test agent-engine/src/adapters/pi-launch.test.ts
 */

import { describe, expect, test } from "bun:test";
import { augmentPiLaunch, isPiLaunchCommand, piEventSockPath, PI_EVENT_SOCK_ENV } from "./pi-launch.ts";

const EXT = "/abs/engine/harness/pi/cyc-output.js";
const SOCK = "/run/pi-evt-ag-abc.sock";

describe("isPiLaunchCommand", () => {
  test("recognises a pi launch, with or without an env prefix or a path", () => {
    expect(isPiLaunchCommand("pi")).toBe(true);
    expect(isPiLaunchCommand("pi --session 1234")).toBe(true);
    expect(isPiLaunchCommand("env CYC_AGENT_ID=ag-0123456789abcdef pi")).toBe(true);
    expect(isPiLaunchCommand("/usr/bin/pi --continue")).toBe(true);
  });

  test("does not recognise claude/codex/opencode or a pi mention that is not the program", () => {
    expect(isPiLaunchCommand("claude")).toBe(false);
    expect(isPiLaunchCommand("codex")).toBe(false);
    expect(isPiLaunchCommand("opencode")).toBe(false);
    expect(isPiLaunchCommand("env CYC_AGENT_ID=ag-0123456789abcdef claude --resume x")).toBe(false);
    // a mention in an argument is not the program
    expect(isPiLaunchCommand("echo pi")).toBe(false);
    // the personal background-lane wrapper is NOT the product pi pane launch
    expect(isPiLaunchCommand("pi-run")).toBe(false);
    expect(isPiLaunchCommand("/home/user/bin/pi-run --continue")).toBe(false);
  });
});

describe("augmentPiLaunch", () => {
  test("a pi launch gains the socket env and the -e extension flag", () => {
    const cmd = "env CYC_AGENT_ID=ag-0123456789abcdef pi";
    const { command, sockPath } = augmentPiLaunch(cmd, { extensionPath: EXT, sockPath: SOCK });
    expect(sockPath).toBe(SOCK);
    expect(command).toContain(`${PI_EVENT_SOCK_ENV}=`);
    expect(command).toContain(SOCK);
    expect(command).toContain(`-e `);
    expect(command).toContain(EXT);
    // the original launch is still in there, verb and all
    expect(command).toContain("pi");
    expect(command).toContain("CYC_AGENT_ID=ag-0123456789abcdef");
  });

  test("a resume launch keeps its --session and still gains -e + sock", () => {
    const { command } = augmentPiLaunch("pi --session 1e5e-uuid", { extensionPath: EXT, sockPath: SOCK });
    expect(command).toContain("--session 1e5e-uuid");
    expect(command).toContain("-e ");
    expect(command).toContain(PI_EVENT_SOCK_ENV);
  });

  test("a NON-pi launch is byte-identical and yields no socket to bind", () => {
    for (const cmd of ["claude", "env CYC_AGENT_ID=ag-0123456789abcdef claude --resume x", "codex", "opencode"]) {
      const out = augmentPiLaunch(cmd, { extensionPath: EXT, sockPath: SOCK });
      expect(out.command).toBe(cmd);
      expect(out.sockPath).toBeNull();
      expect(out.command).not.toContain("-e ");
      expect(out.command).not.toContain(PI_EVENT_SOCK_ENV);
    }
  });
});

describe("piEventSockPath", () => {
  test("is per-key under the run dir and cannot escape it", () => {
    expect(piEventSockPath("/run", "ag-abc")).toBe("/run/pi-evt-ag-abc.sock");
    // a key with path or shell chars is stripped to a filename-safe token
    expect(piEventSockPath("/run", "../../etc/x")).toBe("/run/pi-evt-etcx.sock");
  });
});
