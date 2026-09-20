/* services.test.ts: the service-lifecycle script's --dry-run contract.
 *
 * services.sh start|stop|uninstall drives the SAME services install.sh writes,
 * so --dry-run must name the exact launchctl/systemctl commands per OS and, on
 * uninstall, the cyc shim removal too. The KEY safety property: uninstall never
 * emits a destructive command that names the data dir (~/.callyourcode) or the
 * repos -- it removes only the service definitions and the shim.
 *
 * The real script is never run for effect: --dry-run prints and touches nothing
 * (same convention as scripts/install.test.ts).
 *
 *   bun test scripts/services.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const homes: string[] = [];
function scratchHome(): string {
  const d = mkdtempSync(join(tmpdir(), "services-home-"));
  homes.push(d);
  return d;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

async function dryRun(fakeOs: string, home: string, args: string[]) {
  const proc = Bun.spawn(["sh", "scripts/services.sh", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, CYC_FAKE_OS: fakeOs },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

/** The scratch home is as empty after a dry run as before it. */
function expectUntouched(home: string) {
  expect(readdirSync(home)).toEqual([]);
}

const START_UNITS = [
  "cyc-turn.service",
  "cyc-voice-engine.service",
  "cyc-app-server.service",
  "cyc-agent-engine.service",
];
const STOP_UNITS = [...START_UNITS].reverse();
const START_LABELS = [
  "com.callyourcode.turn",
  "com.callyourcode.voice-engine",
  "com.callyourcode.app-server",
  "com.callyourcode.agent-engine",
];
const STOP_LABELS = [...START_LABELS].reverse();

// ---------------------------------------------------------------------------
// start

test("start on Linux starts TURN, voice, app, then agent engine", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, ["start", "--dry-run"]);

  expect(code).toBe(0);
  expect(out.match(/^\+ systemctl --user start .+$/gm)).toEqual(
    START_UNITS.map((unit) => `+ systemctl --user start ${unit}`),
  );
  expectUntouched(home);
});

test("start on Darwin bootstraps each service (dry-run path) and names cyc pair", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Darwin", home, ["start", "--dry-run"]);

  expect(code).toBe(0);
  const gui = `gui/${process.getuid!()}`;
  expect(out.match(/^\+ launchctl bootstrap .+$/gm)).toEqual(
    START_LABELS.map((label) => `+ launchctl bootstrap ${gui} ${join(home, "Library/LaunchAgents", `${label}.plist`)}`),
  );
  expect(out).toContain("Link a device with: cyc pair");
  expectUntouched(home);
});

// ---------------------------------------------------------------------------
// stop

test("stop on Linux stops agent engine, app, voice, then TURN", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, ["stop", "--dry-run"]);

  expect(code).toBe(0);
  expect(out.match(/^\+ systemctl --user stop .+$/gm)).toEqual(
    STOP_UNITS.map((unit) => `+ systemctl --user stop ${unit}`),
  );
  expectUntouched(home);
});

test("stop on Darwin boots out each service (idempotent)", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Darwin", home, ["stop", "--dry-run"]);

  expect(code).toBe(0);
  const gui = `gui/${process.getuid!()}`;
  for (const label of STOP_LABELS) {
    expect(out).toContain(`+ launchctl bootout ${gui}/${label}`);
  }
  expectUntouched(home);
});

// ---------------------------------------------------------------------------
// uninstall

test("uninstall on Linux disables + removes the units, reloads, and removes the shim", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, ["uninstall", "--dry-run"]);

  expect(code).toBe(0);
  const unitDir = join(home, ".config/systemd/user");
  for (const unit of STOP_UNITS) {
    expect(out).toContain(`+ systemctl --user disable --now ${unit}`);
    expect(out).toContain(`+ rm -f ${join(unitDir, unit)}`);
  }
  expect(out).toContain("+ systemctl --user daemon-reload");
  expect(out).toContain(`+ rm -f ${join(home, ".bun/bin/cyc")}`);
  expectUntouched(home);
});

test("uninstall on Darwin boots out + removes the plists and removes the shim", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Darwin", home, ["uninstall", "--dry-run"]);

  expect(code).toBe(0);
  const gui = `gui/${process.getuid!()}`;
  const plistDir = join(home, "Library/LaunchAgents");
  for (const label of STOP_LABELS) {
    const plist = join(plistDir, `${label}.plist`);
    expect(out).toContain(`+ launchctl bootout ${gui}/${label}`);
    expect(out).toContain(`+ rm -f ${plist}`);
  }
  expect(out).toContain(`+ rm -f ${join(home, ".bun/bin/cyc")}`);
  expectUntouched(home);
});

// The key safety test: uninstall preserves the data dir and the repos. It must
// name them in the "kept" banner, and NEVER in a destructive command.
test("uninstall never removes the data dir: it is named as kept, never in an rm", async () => {
  for (const os of ["Linux", "Darwin"]) {
    const home = scratchHome();
    const { out, code } = await dryRun(os, home, ["uninstall", "--dry-run"]);

    expect(code).toBe(0);

    // Positive: the data dir is explicitly promised as kept.
    expect(out).toContain(`kept: ${join(home, ".callyourcode")} (your data) and the repos`);

    // Negative: no emitted command (+ ...) may name the data dir PATH or a
    // cloned repo. (The service labels legitimately contain "com.callyourcode",
    // so we match the actual paths, not the substring.) run() echoes every
    // action as "+ <cmd>", so scanning those lines covers all destructive ops.
    const dataDir = join(home, ".callyourcode");
    const repoDir = join(home, "callyourcode");
    const appRepoDir = join(home, "callyourcode-app");
    for (const line of out.split("\n")) {
      if (!line.startsWith("+ ")) continue;
      expect(line).not.toContain(dataDir);
      expect(line).not.toContain(repoDir);
      expect(line).not.toContain(appRepoDir);
    }
    expectUntouched(home);
  }
});

// ---------------------------------------------------------------------------
// voice toggle: touches ONLY the voice engine, per platform, idempotently.

/** Drop the voice unit fixture the voice-* actions require to exist (Linux unit
 *  file or macOS plist), so --dry-run shows the command selection rather than
 *  the not-installed short-circuit. */
function installVoiceFixture(os: string, home: string) {
  const path = os === "Linux"
    ? join(home, ".config/systemd/user/cyc-voice-engine.service")
    : join(home, "Library/LaunchAgents/com.callyourcode.voice-engine.plist");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return path;
}

const OTHER_UNITS = ["cyc-turn", "cyc-app-server", "cyc-agent-engine"];
const OTHER_LABELS = ["com.callyourcode.turn", "com.callyourcode.app-server", "com.callyourcode.agent-engine"];

test("voice-off on Linux stops + disables ONLY the voice unit", async () => {
  const home = scratchHome();
  installVoiceFixture("Linux", home);
  const { out, code } = await dryRun("Linux", home, ["voice-off", "--dry-run"]);

  expect(code).toBe(0);
  expect(out).toContain("+ systemctl --user stop cyc-voice-engine.service");
  expect(out).toContain("+ systemctl --user disable cyc-voice-engine.service");
  expect(out).toContain("voice: OFF");
  for (const u of OTHER_UNITS) expect(out).not.toContain(u); // the other three are never named
});

test("voice-on on Linux enables + starts the voice unit", async () => {
  const home = scratchHome();
  installVoiceFixture("Linux", home);
  const { out, code } = await dryRun("Linux", home, ["voice-on", "--dry-run"]);

  expect(code).toBe(0);
  expect(out).toContain("+ systemctl --user enable cyc-voice-engine.service");
  expect(out).toContain("+ systemctl --user start cyc-voice-engine.service");
  expect(out).toContain("voice: ON");
});

test("voice-status on Linux emits the read-only probes and runs nothing under dry-run", async () => {
  const home = scratchHome();
  installVoiceFixture("Linux", home);
  const { out, code } = await dryRun("Linux", home, ["voice-status", "--dry-run"]);

  expect(code).toBe(0);
  expect(out).toContain("+ systemctl --user is-enabled cyc-voice-engine.service");
  expect(out).toContain("+ systemctl --user is-active cyc-voice-engine.service");
  expect(out).not.toContain("enabled="); // the live state line is skipped in a dry run
});

test("voice-off with no voice unit installed is a clean message, exit 0, no commands (Linux + Darwin)", async () => {
  for (const os of ["Linux", "Darwin"]) {
    const home = scratchHome();
    const { out, code } = await dryRun(os, home, ["voice-off", "--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("voice: not installed");
    expect(out).not.toContain("+ "); // nothing manipulated
    expectUntouched(home);
  }
});

test("voice-off on Darwin boots out + disables ONLY the voice label", async () => {
  const home = scratchHome();
  installVoiceFixture("Darwin", home);
  const { out, code } = await dryRun("Darwin", home, ["voice-off", "--dry-run"]);

  expect(code).toBe(0);
  const gui = `gui/${process.getuid!()}`;
  expect(out).toContain(`+ launchctl bootout ${gui}/com.callyourcode.voice-engine`);
  expect(out).toContain(`+ launchctl disable ${gui}/com.callyourcode.voice-engine`);
  expect(out).toContain("voice: OFF");
  for (const l of OTHER_LABELS) expect(out).not.toContain(l);
});

test("voice-on on Darwin enables + bootstraps the voice plist", async () => {
  const home = scratchHome();
  const plist = installVoiceFixture("Darwin", home);
  const { out, code } = await dryRun("Darwin", home, ["voice-on", "--dry-run"]);

  expect(code).toBe(0);
  const gui = `gui/${process.getuid!()}`;
  expect(out).toContain(`+ launchctl enable ${gui}/com.callyourcode.voice-engine`);
  expect(out).toContain(`+ launchctl bootstrap ${gui} ${plist}`);
  expect(out).toContain("voice: ON");
});

// ---------------------------------------------------------------------------
// voice toggle: the persisted "voice off" marker (~/.callyourcode/voice-disabled)
// that a reinstall honors. `voice off` writes it, `voice on` removes it,
// `voice status` reports it. The marker write/remove is emitted through run()
// so --dry-run only prints the command and never touches a real unit or a real
// marker: every assertion below is on the dry-run command list, plus a marker
// planted directly in the fixture HOME for the status report.

/** Plant the persisted-off marker in a fixture HOME's data dir. */
function writeMarker(home: string) {
  const dir = join(home, ".callyourcode");
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, "voice-disabled");
  writeFileSync(marker, "");
  return marker;
}

test("voice-off persists the choice: it would create the data dir 0700 and touch the marker", async () => {
  const home = scratchHome();
  installVoiceFixture("Linux", home);
  const { out, code } = await dryRun("Linux", home, ["voice-off", "--dry-run"]);

  expect(code).toBe(0);
  const marker = join(home, ".callyourcode", "voice-disabled");
  expect(out).toContain(`+ mkdir -p -m 0700 ${join(home, ".callyourcode")}`);
  expect(out).toContain(`+ touch ${marker}`);
  expect(out).toContain(`voice: persisted OFF (${marker})`);
});

test("voice-on clears the persisted choice: it would remove the marker", async () => {
  const home = scratchHome();
  installVoiceFixture("Linux", home);
  const { out, code } = await dryRun("Linux", home, ["voice-on", "--dry-run"]);

  expect(code).toBe(0);
  const marker = join(home, ".callyourcode", "voice-disabled");
  expect(out).toContain(`+ rm -f ${marker}`);
  expect(out).toContain("voice: persisted-off marker cleared");
});

test("voice-status reports the persisted-off marker when present, and its absence otherwise", async () => {
  for (const os of ["Linux", "Darwin"]) {
    // absent: no marker planted
    const home1 = scratchHome();
    installVoiceFixture(os, home1);
    const { out: outAbsent, code: c1 } = await dryRun(os, home1, ["voice-status", "--dry-run"]);
    expect(c1).toBe(0);
    expect(outAbsent).toContain("voice: no persisted-off marker");

    // present: marker planted directly in the fixture HOME
    const home2 = scratchHome();
    installVoiceFixture(os, home2);
    const marker = writeMarker(home2);
    const { out: outPresent, code: c2 } = await dryRun(os, home2, ["voice-status", "--dry-run"]);
    expect(c2).toBe(0);
    expect(outPresent).toContain(`voice: persisted off (marker ${marker} present`);
  }
});

test("voice-off on Darwin also persists the marker (cross-platform)", async () => {
  const home = scratchHome();
  installVoiceFixture("Darwin", home);
  const { out, code } = await dryRun("Darwin", home, ["voice-off", "--dry-run"]);

  expect(code).toBe(0);
  expect(out).toContain(`+ touch ${join(home, ".callyourcode", "voice-disabled")}`);
  expect(out).toContain("voice: persisted OFF");
});

// ---------------------------------------------------------------------------
// usage / bad input

test("an unknown subcommand exits 2 with usage and emits no actions", async () => {
  const home = scratchHome();
  const { out, err, code } = await dryRun("Linux", home, ["frobnicate", "--dry-run"]);

  expect(code).toBe(2);
  expect(err).toContain("usage:");
  expect(out).not.toContain("+ "); // nothing ran
  expectUntouched(home);
});

test("a missing subcommand exits 2 with usage", async () => {
  const home = scratchHome();
  const { err, code } = await dryRun("Linux", home, []);

  expect(code).toBe(2);
  expect(err).toContain("usage:");
  expectUntouched(home);
});
