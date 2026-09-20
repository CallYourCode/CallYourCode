/* install.test.ts (#pairing-onboarding): the installer's --dry-run contract.
 *
 * --dry-run must name every step -- the per-OS unit file paths, the linger
 * step on Linux, the dependency steps (the multiplexer and the prebuilt sherpa addon), and
 * the one harness-integration call it now delegates all three harnesses to
 * -- and touch NOTHING: no clone, no writes under the (scratch) home, no
 * systemd or LaunchAgent files, no harness configs, no data dir. The real
 * installer is never run here (the per-harness install is covered hermetically
 * in scripts/harness-integration.test.ts).
 *
 *   bun test scripts/install.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const homes: string[] = [];
function scratchHome(): string {
  const d = mkdtempSync(join(tmpdir(), "install-home-"));
  homes.push(d);
  return d;
}
const fixtures: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  while (fixtures.length) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

async function dryRun(fakeOs: string, home: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []) {
  const proc = Bun.spawn(["sh", "scripts/install.sh", "--dry-run", ...extraArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, CYC_FAKE_OS: fakeOs, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

/** Build a throwaway source tree whose scripts/install.sh is a copy of the real
 *  one, so a --local run's script-location REPO_DIR (install.sh:105-109) is this
 *  temp dir. withDist plants the checked-in app bundle that the --local path now
 *  validates even under --dry-run; omitting it yields a dist-less tree the guard
 *  must reject. */
function localRepoFixture(withDist: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "install-repo-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "scripts/install.sh"), join(root, "scripts/install.sh"));
  if (withDist) {
    mkdirSync(join(root, "app/dist/plugins"), { recursive: true });
    for (const f of ["index.html", "build.txt", "plugins/git-page.html", "plugins/files-page.html"]) {
      writeFileSync(join(root, "app/dist", f), "");
    }
  }
  return root;
}

/** Run the copied installer in --local --dry-run from a fixture source tree, so
 *  REPO_DIR (and hence DIST_DIR) resolves inside that tree. */
async function dryRunLocal(repoDir: string, home: string) {
  const proc = Bun.spawn(["sh", join(repoDir, "scripts/install.sh"), "--dry-run", "--local"], {
    cwd: repoDir,
    env: { ...process.env, HOME: home, CYC_FAKE_OS: "Linux" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

/** The whole "touches nothing" contract in one assertion: the scratch home is
 *  as empty after the dry run as it was before it. */
function expectUntouched(home: string) {
  expect(readdirSync(home)).toEqual([]);
}

test("--dry-run Linux names the systemd unit paths and touches nothing", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  expect(out).toContain(join(home, ".config/systemd/user/cyc-agent-engine.service"));
  expect(out).toContain(join(home, ".config/systemd/user/cyc-app-server.service"));
  expect(out).toContain(join(home, ".config/systemd/user/cyc-voice-engine.service"));
  expect(out).toContain(join(home, ".config/systemd/user/cyc-turn.service"));
  expect(out).toContain("+ systemctl --user daemon-reload");
  expect(out).toContain("+ systemctl --user enable cyc-turn.service cyc-voice-engine.service cyc-app-server.service cyc-agent-engine.service");
  expect(out).toContain("+ systemctl --user restart cyc-turn.service cyc-voice-engine.service cyc-app-server.service cyc-agent-engine.service");
  // no standalone whisper unit any more: stt serves batch too
  expect(out).not.toContain("cyc-whisper.service");

  expectUntouched(home);
});

/** Plant the persisted `cyc voice off` marker in a fixture HOME's data dir, so
 *  the installer's voice-off-aware branch is exercised without touching a real
 *  unit or a real marker. */
function writeVoiceDisabledMarker(home: string) {
  const dir = join(home, ".callyourcode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "voice-disabled"), "");
}

test("marker present on Linux: enable+restart skip ONLY the voice unit; the other three stay", async () => {
  const home = scratchHome();
  writeVoiceDisabledMarker(home);
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  // the three non-voice units are still enabled + restarted, voice is dropped
  expect(out).toContain("+ systemctl --user enable cyc-turn.service cyc-app-server.service cyc-agent-engine.service");
  expect(out).toContain("+ systemctl --user restart cyc-turn.service cyc-app-server.service cyc-agent-engine.service");
  // the four-unit lines (with voice) must NOT appear
  expect(out).not.toContain("+ systemctl --user enable cyc-turn.service cyc-voice-engine.service cyc-app-server.service cyc-agent-engine.service");
  expect(out).not.toContain("+ systemctl --user restart cyc-turn.service cyc-voice-engine.service cyc-app-server.service cyc-agent-engine.service");
  expect(out).toContain("voice: disabled (cyc voice off); leaving it off");
});

test("marker present on Darwin: bootstrap skips ONLY the voice plist; the other three stay", async () => {
  const home = scratchHome();
  writeVoiceDisabledMarker(home);
  const { out, code } = await dryRun("Darwin", home);

  expect(code).toBe(0);
  const gui = `gui/${process.getuid!()}`;
  const p = (label: string) => join(home, "Library/LaunchAgents", `${label}.plist`);
  expect(out).toContain(`+ launchctl bootstrap ${gui} ${p("com.callyourcode.turn")}`);
  expect(out).toContain(`+ launchctl bootstrap ${gui} ${p("com.callyourcode.app-server")}`);
  expect(out).toContain(`+ launchctl bootstrap ${gui} ${p("com.callyourcode.agent-engine")}`);
  // the voice plist is written (unit still installed) but NEVER bootstrapped
  expect(out).not.toContain(`+ launchctl bootstrap ${gui} ${p("com.callyourcode.voice-engine")}`);
  expect(out).toContain("voice: disabled (cyc voice off); leaving it off");
});

test("no marker: all four units enable as before (Linux) and bootstrap (Darwin)", async () => {
  // Linux: the four-unit enable line is intact and no voice-off notice appears.
  const linuxHome = scratchHome();
  const { out: linux, code: lc } = await dryRun("Linux", linuxHome);
  expect(lc).toBe(0);
  expect(linux).toContain("+ systemctl --user enable cyc-turn.service cyc-voice-engine.service cyc-app-server.service cyc-agent-engine.service");
  expect(linux).not.toContain("voice: disabled (cyc voice off)");
  expectUntouched(linuxHome);

  // Darwin: the voice plist IS bootstrapped and no voice-off notice appears.
  const darwinHome = scratchHome();
  const { out: darwin, code: dc } = await dryRun("Darwin", darwinHome);
  expect(dc).toBe(0);
  const gui = `gui/${process.getuid!()}`;
  expect(darwin).toContain(`+ launchctl bootstrap ${gui} ${join(darwinHome, "Library/LaunchAgents", "com.callyourcode.voice-engine.plist")}`);
  expect(darwin).not.toContain("voice: disabled (cyc voice off)");
  expectUntouched(darwinHome);
});

test("--dry-run Darwin names the LaunchAgent plist paths and touches nothing", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Darwin", home);

  expect(code).toBe(0);
  expect(out).toContain(join(home, "Library/LaunchAgents/com.callyourcode.agent-engine.plist"));
  expect(out).toContain(join(home, "Library/LaunchAgents/com.callyourcode.app-server.plist"));
  expect(out).toContain(join(home, "Library/LaunchAgents/com.callyourcode.voice-engine.plist"));
  expect(out).toContain(join(home, "Library/LaunchAgents/com.callyourcode.turn.plist"));
  expect(out).not.toContain("com.callyourcode.whisper.plist");

  expectUntouched(home);
});

test("--dry-run Linux names the linger step", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  expect(out).toContain("loginctl enable-linger");
  expectUntouched(home);
});

test("--dry-run Darwin has no linger step", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Darwin", home);

  expect(code).toBe(0);
  expect(out).not.toContain("loginctl");
  expectUntouched(home);
});

test("--dry-run names the data dir step (0700, no files)", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  expect(out).toContain(`data: ${join(home, ".callyourcode")} (0700, no files written)`);
  expectUntouched(home);
});

test("--dry-run names the dependency steps: the multiplexer and the prebuilt sherpa addon", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, { CYC_FAKE_TMUX: "present" });

  expect(code).toBe(0);
  expect(out).toMatch(/^deps: multiplexer$/m);
  // The python voice stack is gone: no kokoro clone, no stt venv, no whisper.cpp.
  // The engine's ONE native dep is the prebuilt sherpa-onnx addon via bun install.
  expect(out).not.toContain("whisper.cpp");
  expect(out).not.toContain("deps: kokoro");
  expect(out).not.toContain("deps: stt");
  expect(out).toContain("deps: bun install in voice-engine (sherpa-onnx, prebuilt)");
  expectUntouched(home);
});

test("default mux is tmux: no CYC_MUX step, no herdr install", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, { CYC_FAKE_TMUX: "present" });

  expect(code).toBe(0);
  expect(out).toContain("mux: tmux (default)");
  expect(out).not.toContain("CYC_MUX");
  expect(out).not.toContain("herdr.dev/install.sh");
  expectUntouched(home);
});

test("CYC_MUX=herdr opts into herdr: CYC_MUX=herdr named, herdr installed", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, { CYC_MUX: "herdr", CYC_FAKE_HERDR: "present" });

  expect(code).toBe(0);
  expect(out).toContain("deps: herdr (opted in via CYC_MUX=herdr)");
  expect(out).toContain("mux: herdr (opt-in)");
  expectUntouched(home);

  /* The env actually reaches the service templates: one Environment= line in
   * the systemd unit, one EnvironmentVariables entry in the launchd plist,
   * both threaded only when the mux is herdr. */
  const script = await Bun.file(join(REPO_ROOT, "scripts/install.sh")).text();
  expect(script).toContain("Environment=CYC_MUX=herdr");
  expect(script).toContain("<key>CYC_MUX</key>");
});

test("tmux absent on Linux: the prereq gate names tmux, never runs privileged commands", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, { CYC_FAKE_TMUX: "absent" });

  expect(code).toBe(0); // dry-run names the stop; the real install exits 1 there
  expect(out).toContain("prereqs: missing (tmux); install would stop here");
  expect(out).not.toMatch(/^\+ su/m);
  expectUntouched(home);
});

test("CYC_MUX=herdr but herdr absent on Linux: the prereq gate names herdr, not tmux", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home, { CYC_MUX: "herdr", CYC_FAKE_HERDR: "absent" });

  expect(code).toBe(0);
  expect(out).toContain("prereqs: missing (herdr); install would stop here");
  expectUntouched(home);
});

test("default mux tmux on Darwin: the plist path carries no CYC_MUX", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Darwin", home, { CYC_FAKE_TMUX: "present" });

  expect(code).toBe(0);
  expect(out).toContain("mux: tmux (default)");
  expect(out).toContain(join(home, "Library/LaunchAgents/com.callyourcode.agent-engine.plist"));
  expectUntouched(home);
});

test("install never downloads the voice models: the engine fetches them in the background", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  /* The ~2 GB of models must not block install: no model download command in
   * the flow at all, on a home where both models are missing. */
  expect(out).not.toContain("download-ggml-model.sh");
  expect(out).not.toContain("kokoro-v1_0.pth\"");
  expect(out).toMatch(/voice models: missing; the engine downloads them in the background/);
  /* The standalone whisper.cpp build + unit are GONE: sherpa-onnx's offline
   * whisper serves both batch and streaming in-process, and its presence gate
   * holds it down until the model lands. The installer must no longer name
   * whisper.cpp anywhere. */
  const script = await Bun.file(join(REPO_ROOT, "scripts/install.sh")).text();
  expect(script).not.toContain("whisper.cpp");
  expect(script).not.toContain("cyc-whisper");
  expect(script).not.toContain("WHISPER_MODEL");
  expectUntouched(home);
});

test("--dry-run names the checked-in app bundle and touches nothing", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  expect(out).not.toContain("app: clone");
  expect(out).not.toContain("pnpm");
  expect(out).toContain(`app bundle: ${join(home, "callyourcode/app/dist")}`);
  expect(out).not.toContain("app deps: bun install in app");
  expect(out).not.toContain("app build:");
  expectUntouched(home);
});

test("--local --dry-run validates the on-disk dist, never clones, when the bundle is present", async () => {
  const home = scratchHome();
  // --local uses the source tree the installer runs from (its own location), and
  // that tree already carries the built app bundle.
  const repo = localRepoFixture(true);
  const { out, code } = await dryRunLocal(repo, home);

  expect(code).toBe(0);
  expect(out).toContain("repo: local mode");
  expect(out).toContain(`app bundle: ${join(repo, "app/dist")}`);
  // the whole point: the repo is not cloned or pulled (the app comes with it).
  expect(out).not.toContain("repo: clone");
  expect(out).not.toContain("app: clone");
  expect(out).not.toMatch(/pull --ff-only/);
});

test("--local --dry-run fails loudly when the on-disk source tree has no app bundle", async () => {
  const home = scratchHome();
  // A dist-less (broken / from-source-not-built) tree: --local can and must
  // catch this even in a dry-run, because the dist is already on disk right now.
  const repo = localRepoFixture(false);
  const { out, err, code } = await dryRunLocal(repo, home);

  expect(code).toBe(1);
  expect(`${out}${err}`).toContain("checked-in app bundle is missing");
  expect(`${out}${err}`).toContain(join(repo, "app/dist"));
});

/** Pull one write_file here-doc body out of the installer source, by the shell
 *  variable it writes to (e.g. "ENGINE_UNIT", "ENGINE_PLIST"). */
function heredocFor(script: string, varName: string): string {
  const start = script.indexOf(`write_file "$${varName}" <<EOF\n`);
  if (start < 0) throw new Error(`no write_file for $${varName}`);
  const bodyStart = start + `write_file "$${varName}" <<EOF\n`.length;
  const end = script.indexOf("\nEOF\n", bodyStart);
  if (end < 0) throw new Error(`unterminated here-doc for $${varName}`);
  return script.slice(bodyStart, end);
}

test("the engine service unit puts .local/bin + .bun/bin on PATH so it can spawn herdr + cyc", async () => {
  const script = await Bun.file(join(REPO_ROOT, "scripts/install.sh")).text();

  // Linux systemd: a PATH Environment line with the herdr dir (~/.local/bin,
  // via %h) and the bun/cyc dir (~/.bun/bin), so the engine finds the mux
  // binary and the cyc shim it spawns at runtime.
  const engineUnit = heredocFor(script, "ENGINE_UNIT");
  const pathLine = engineUnit.split("\n").find((l) => l.startsWith("Environment=PATH="));
  expect(pathLine).toBeDefined();
  expect(pathLine).toContain("%h/.local/bin");
  expect(pathLine).toContain("%h/.bun/bin");

  // macOS launchd: the same two dirs on the plist PATH EnvironmentVariables
  // entry ($HOME-expanded, plists do not do %h).
  const enginePlist = heredocFor(script, "ENGINE_PLIST");
  const pathIdx = enginePlist.indexOf("<key>PATH</key>");
  expect(pathIdx).toBeGreaterThanOrEqual(0);
  const plistPath = enginePlist.slice(pathIdx, pathIdx + 200);
  expect(plistPath).toContain("$HOME/.local/bin");
  expect(plistPath).toContain("$HOME/.bun/bin");
});

test("--dry-run names the cyc shim step and touches nothing", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  expect(out).toContain(`cyc: install shim -> ${join(home, ".bun/bin/cyc")}`);
  expect(out).toContain(`would write: ${join(home, ".bun/bin/cyc")}`);
  expectUntouched(home);
});

// install.sh no longer detects harnesses or names install-user.sh: it
// delegates every harness (claude, opencode, codex) to one harness-integration
// call, which does its own detection/merge/backup (see harness-integration.test.ts).
test("--dry-run delegates all harnesses to one harness-integration call and touches nothing", async () => {
  const home = scratchHome();
  const { out, code } = await dryRun("Linux", home);

  expect(code).toBe(0);
  expect(out).toContain("harness: integrate detected harnesses (claude, opencode, codex)");
  // one call handles all three; the dry-run flag is carried through
  expect(out).toMatch(/harness-integration\.ts --dry-run/);
  // the retired claude-only script is gone from the flow
  expect(out).not.toContain("install-user.sh");

  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(existsSync(join(home, ".config/opencode"))).toBe(false);
  expect(existsSync(join(home, ".codex"))).toBe(false);
  expectUntouched(home);
});
