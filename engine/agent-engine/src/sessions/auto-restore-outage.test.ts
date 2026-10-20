import { expect, test } from "bun:test";

// The startup deadline uses Date.now(). Isolate its clock spy from timers left
// alive by other suites, and keep the real snapshot/file I/O inside the child.
test("recording survives startup outage with empty and existing state", async () => {
  const child = Bun.spawn([
    "env", "-u", "HERDR_PANE_ID", "-u", "TMUX_PANE", "-u", "CYC_AGENT_ID", "-u", "HERDR_ENV",
    "-u", "HERDR_WORKSPACE_ID", "-u", "HERDR_TAB_ID", "AGENT_PORT=1", "CYC_ENGINE_URL=http://127.0.0.1:1",
    process.execPath, "test", new URL("../fixtures/auto-restore-outage.ts", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  try {
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, out + err).toBe(0);
    expect(err).toContain("2 pass");
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}, 15_000);
