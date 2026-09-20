/* The harness wiring self-check: pure scans over IN-MEMORY config fixtures.
 * The machine's live configs are never read: every case injects its own
 * exists/read, so nothing here touches a real ~/.claude.json or ~/.codex.
 *
 *   bun test src/runtime/harness-config-check.test.ts
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  wiredPathsIn,
  scanConfig,
  harnessConfigFiles,
  checkHarnessConfigs,
  repairCodexMcpToml,
  healCodexMcpPathAtBoot,
  harnessCopyTargets,
  healCopyTarget,
  healHarnessCopiesAtBoot,
  WIRED_SCRIPTS,
  type CopyIo,
} from "./harness-config-check.ts";

test("wiredPathsIn picks out only this project's engine scripts, deduped", () => {
  const text = JSON.stringify({
    mcpServers: {
      callyourcode: { command: "bun", args: ["/home/a/callyourcode/engine/mcp/src/server.ts"] },
      // A FOREIGN mcp server with its own absolute server.ts -- must NOT be flagged.
      other: { command: "bun", args: ["/opt/other-tool/server.ts"] },
    },
    hooks: {
      Stop: [{ hooks: [{ command: "python3 /home/a/callyourcode/engine/hooks/enforce-voice-reply.py" }] }],
    },
  });
  const paths = wiredPathsIn(text + text); // duplicated: dedupe must hold
  expect(paths.sort()).toEqual([
    "/home/a/callyourcode/engine/hooks/enforce-voice-reply.py",
    "/home/a/callyourcode/engine/mcp/src/server.ts",
  ]);
});

test("wiredPathsIn finds nothing in a launcher-wired config (the footgun is gone)", () => {
  const claude = JSON.stringify({ mcpServers: { callyourcode: { command: "cyc", args: ["mcp"] } } });
  const settings = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: "cyc hook enforce-voice-reply" }] }] },
  });
  const codex = '[mcp_servers.callyourcode]\ncommand = "cyc"\nargs = ["mcp"]\n';
  expect(wiredPathsIn(claude)).toEqual([]);
  expect(wiredPathsIn(settings)).toEqual([]);
  expect(wiredPathsIn(codex)).toEqual([]);
});

test("wiredPathsIn reads codex TOML args arrays too", () => {
  const toml =
    'notify = ["python3", "/x/callyourcode/engine/hooks/announce-session.py", "--codex-notify"]\n' +
    '[mcp_servers.callyourcode]\ncommand = "bun"\nargs = ["/x/callyourcode/engine/mcp/src/server.ts"]\n';
  expect(wiredPathsIn(toml).sort()).toEqual([
    "/x/callyourcode/engine/hooks/announce-session.py",
    "/x/callyourcode/engine/mcp/src/server.ts",
  ]);
});

test("scanConfig warns for a dead path, stays silent for a live one", () => {
  const dead = "/gone/callyourcode/engine/mcp/src/server.ts";
  const live = "/here/callyourcode/engine/mcp/src/server.ts";
  const text = JSON.stringify({ mcpServers: { callyourcode: { command: "bun", args: [dead] } } });
  const exists = (p: string) => p === live;
  const warns = scanConfig("claude", "/h/.claude.json", text, exists);
  expect(warns).toEqual([{ harness: "claude", file: "/h/.claude.json", path: dead }]);
  // The same wiring, but the file is actually present: no warning.
  const ok = JSON.stringify({ mcpServers: { callyourcode: { command: "bun", args: [live] } } });
  expect(scanConfig("claude", "/h/.claude.json", ok, exists)).toEqual([]);
});

test("harnessConfigFiles honours codex + xdg overrides", () => {
  const files = harnessConfigFiles({
    home: "/h",
    codexHome: "/custom/codex",
    xdgConfigHome: "/xdg",
  });
  const paths = files.map((f) => f.file);
  expect(paths).toContain("/h/.claude.json");
  expect(paths).toContain(join("/h", ".claude", "settings.json"));
  expect(paths).toContain("/xdg/opencode/opencode.json");
  expect(paths).toContain("/custom/codex/config.toml");
  expect(paths).toContain("/custom/codex/hooks.json");
});

test("checkHarnessConfigs: a copied config with a dead engine path is caught for the right harness", () => {
  // Simulates a config copied from another box (/home/olduser/...) onto a box whose
  // engine lives elsewhere: the absolute path is dead here.
  const stale = "/home/olduser/callyourcode/engine/mcp/src/server.ts";
  const codexToml =
    '[mcp_servers.callyourcode]\ncommand = "bun"\nargs = ["/home/olduser/callyourcode/engine/mcp/src/server.ts"]\n';
  const files: Record<string, string> = {
    "/box/.claude.json": JSON.stringify({ mcpServers: { callyourcode: { command: "bun", args: [stale] } } }),
    "/box/.codex/config.toml": codexToml,
    // opencode is already on the launcher here: no absolute path, no warning.
    "/box/.config/opencode/opencode.json": JSON.stringify({
      mcp: { callyourcode: { type: "local", command: ["cyc", "mcp"] } },
    }),
  };
  const io = {
    exists: (p: string) => p in files, // the dead engine path is NOT a key: absent
    read: (p: string) => files[p] ?? null,
  };
  const warns = checkHarnessConfigs({ home: "/box" }, io);
  expect(warns).toEqual([
    { harness: "claude", file: "/box/.claude.json", path: stale },
    { harness: "codex", file: "/box/.codex/config.toml", path: stale },
  ]);
});

test("checkHarnessConfigs: an all-launcher machine boots clean (no warnings)", () => {
  const files: Record<string, string> = {
    "/box/.claude.json": JSON.stringify({ mcpServers: { callyourcode: { command: "cyc", args: ["mcp"] } } }),
    "/box/.claude/settings.json": JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: "cyc hook enforce-voice-reply" }] }] },
    }),
  };
  const io = { exists: (p: string) => p in files, read: (p: string) => files[p] ?? null };
  expect(checkHarnessConfigs({ home: "/box" }, io)).toEqual([]);
});

test("checkHarnessConfigs: a dead absolute hook path in ~/.codex/hooks.json is caught, the launcher form is clean", () => {
  // The codex Stop hook is the exact path config-portable left absolute: a
  // hooks.json copied from another box points at that box's engine, so the Stop
  // hook fails and codex's outbound reply dies silently. The boot self-check
  // must flag it (and the migrated `cyc hook` form must be immune).
  const stale = "/home/olduser/callyourcode/engine/hooks/enforce-voice-reply.py"
  const deadHooks: Record<string, string> = {
    "/box/.codex/hooks.json": JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `python3 ${stale}` }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "echo mine" }] }], // foreign: never flagged
      },
    }),
  }
  const deadIo = { exists: (p: string) => p in deadHooks, read: (p: string) => deadHooks[p] ?? null }
  expect(checkHarnessConfigs({ home: "/box" }, deadIo)).toEqual([
    { harness: "codex", file: "/box/.codex/hooks.json", path: stale },
  ])

  // Same file, migrated to the launcher: no absolute path, no warning.
  const liveHooks: Record<string, string> = {
    "/box/.codex/hooks.json": JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "cyc hook enforce-voice-reply" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "cyc hook enforce-shell-async" }] }],
      },
    }),
  }
  const liveIo = { exists: (p: string) => p in liveHooks, read: (p: string) => liveHooks[p] ?? null }
  expect(checkHarnessConfigs({ home: "/box" }, liveIo)).toEqual([])
})

test("repairCodexMcpToml: a dead absolute mcp path is rewritten to the `cyc mcp` launcher, other bytes intact", () => {
  const toml =
    'notify = ["cyc", "hook", "announce-session", "--codex-notify"]\n' +
    "model = \"gpt-5.6\"\n\n" +
    '[mcp_servers.callyourcode]\ncommand = "bun"\nargs = ["/gone/callyourcode/engine/mcp/src/server.ts"]\n\n' +
    '[projects."/home/x"]\ntrust_level = "trusted"\n';
  const r = repairCodexMcpToml(toml, () => false); // the path is dead
  expect(r.changed).toBe(true);
  expect(r.note).toContain("dead");
  // The section is now the launcher; every other line is preserved.
  expect(r.text).toContain('[mcp_servers.callyourcode]\ncommand = "cyc"\nargs = ["mcp"]');
  expect(r.text).toContain('notify = ["cyc", "hook", "announce-session", "--codex-notify"]');
  expect(r.text).toContain('model = "gpt-5.6"');
  expect(r.text).toContain('[projects."/home/x"]\ntrust_level = "trusted"');
  expect(r.text).not.toContain("/gone/callyourcode");
  // And re-scanning finds no dead path (the footgun is gone for good).
  expect(wiredPathsIn(r.text)).toEqual([]);
});

test("repairCodexMcpToml: a LIVE-but-absolute mcp path is still upgraded to the launcher (drift-proofed)", () => {
  const toml =
    '[mcp_servers.callyourcode]\ncommand = "bun"\nargs = ["/here/callyourcode/engine/mcp/src/server.ts"]\n';
  const r = repairCodexMcpToml(toml, () => true); // the path resolves here
  expect(r.changed).toBe(true);
  expect(r.note).toContain("portable");
  expect(r.text).toContain('command = "cyc"\nargs = ["mcp"]');
});

test("repairCodexMcpToml: already on the launcher is a no-op", () => {
  const toml = '[mcp_servers.callyourcode]\ncommand = "cyc"\nargs = ["mcp"]\n';
  expect(repairCodexMcpToml(toml, () => false)).toEqual({
    text: toml,
    changed: false,
    note: "already on `cyc mcp`",
  });
});

test("repairCodexMcpToml: no callyourcode section, or a foreign one, is left untouched", () => {
  const none = 'model = "gpt-5.6"\n[mcp_servers.other]\ncommand = "bun"\nargs = ["/opt/other/server.ts"]\n';
  expect(repairCodexMcpToml(none, () => false).changed).toBe(false);
  expect(repairCodexMcpToml(none, () => false).text).toBe(none);
});

test("healCodexMcpPathAtBoot: reads, repairs and writes the config exactly once, only when changed", () => {
  let written: { path: string; text: string } | null = null;
  const store: Record<string, string> = {
    "/box/.codex/config.toml":
      '[mcp_servers.callyourcode]\ncommand = "bun"\nargs = ["/gone/callyourcode/engine/mcp/src/server.ts"]\n',
  };
  const io = {
    exists: (p: string) => p in store, // the dead engine path is not a key: absent
    read: (p: string) => store[p] ?? null,
    write: (p: string, text: string) => { written = { path: p, text }; },
    path: () => "/box/.codex/config.toml",
  };
  const logs: string[] = [];
  const first = healCodexMcpPathAtBoot((l) => logs.push(l), io);
  expect(first.changed).toBe(true);
  expect(written).not.toBeNull();
  expect(written!.text).toContain('command = "cyc"\nargs = ["mcp"]');
  expect(logs.length).toBe(1);

  // A second boot over the already-healed config writes nothing.
  store["/box/.codex/config.toml"] = written!.text;
  written = null;
  const second = healCodexMcpPathAtBoot(() => {}, io);
  expect(second.changed).toBe(false);
  expect(written).toBeNull();
});

test("WIRED_SCRIPTS lists exactly the scripts the harness installer wires", () => {
  expect([...WIRED_SCRIPTS].sort()).toEqual([
    "announce-session.py",
    "enforce-bash-async.py",
    "enforce-shell-async.py",
    "enforce-voice-reply.py",
    "server.ts",
  ]);
});

// ---------------------------------------------------------------------------
// Copy self-heal: the harness-side artifacts the installer COPIES out of the
// repo (never wired by launcher, so a deploy never refreshes them). All cases
// inject an in-memory fs; nothing here touches a real copy on disk.

/** A hermetic filesystem over a flat map of file path -> content. A directory
 *  "exists" when it is a path-prefix of some file. `writes`/`removes` record the
 *  mutations so a test can assert a copy was (or was NOT) touched. */
function memIo(files: Record<string, string>): CopyIo & {
  files: Record<string, string>;
  writes: string[];
  removes: string[];
} {
  const store = { ...files };
  const writes: string[] = [];
  const removes: string[] = [];
  const isDir = (p: string) => Object.keys(store).some((f) => f.startsWith(p.replace(/\/?$/, "/")));
  return {
    files: store,
    writes,
    removes,
    exists: (p) => p in store || isDir(p),
    read: (p) => {
      if (!(p in store)) throw new Error(`ENOENT ${p}`);
      return store[p]!;
    },
    write: (p, text) => {
      store[p] = text;
      writes.push(p);
    },
    remove: (p) => {
      delete store[p];
      removes.push(p);
    },
    listFiles: (dir) => {
      const pre = dir.replace(/\/?$/, "/");
      return Object.keys(store)
        .filter((f) => f.startsWith(pre))
        .map((f) => f.slice(pre.length));
    },
  };
}

test("harnessCopyTargets: the four installer copies, destinations honour codex + xdg overrides, incl. the opencode skill", () => {
  const targets = harnessCopyTargets({
    home: "/h",
    engineRoot: "/repo/engine",
    codexHome: "/custom/codex",
    xdgConfigHome: "/xdg",
  });
  expect(targets.map((t) => `${t.label}:${t.kind}`)).toEqual([
    "opencode plugin:file",
    "claude skill:dir",
    "codex skill:dir",
    "opencode skill:dir",
  ]);
  const byLabel = Object.fromEntries(targets.map((t) => [t.label, t]));
  expect(byLabel["opencode plugin"]!.src).toBe("/repo/engine/harness/opencode/callyourcode.ts");
  expect(byLabel["opencode plugin"]!.dst).toBe("/xdg/opencode/plugin/callyourcode.ts");
  expect(byLabel["claude skill"]!.src).toBe("/repo/engine/skills/callyourcode");
  expect(byLabel["claude skill"]!.dst).toBe(join("/h", ".claude", "skills", "callyourcode"));
  expect(byLabel["codex skill"]!.src).toBe("/repo/engine/skills/callyourcode");
  expect(byLabel["codex skill"]!.dst).toBe("/custom/codex/skills/callyourcode");
  // The FOURTH copy: the opencode skill dir, sharing the same repo source, landing
  // under the resolved opencode config root (same root as the plugin copy).
  expect(byLabel["opencode skill"]!.src).toBe("/repo/engine/skills/callyourcode");
  expect(byLabel["opencode skill"]!.dst).toBe("/xdg/opencode/skill/callyourcode");
});

test("harnessCopyTargets: default codex + opencode roots when no overrides", () => {
  const targets = harnessCopyTargets({ home: "/h", engineRoot: "/repo/engine" });
  const byLabel = Object.fromEntries(targets.map((t) => [t.label, t]));
  expect(byLabel["opencode plugin"]!.dst).toBe(join("/h", ".config", "opencode", "plugin", "callyourcode.ts"));
  expect(byLabel["codex skill"]!.dst).toBe(join("/h", ".codex", "skills", "callyourcode"));
  expect(byLabel["opencode skill"]!.dst).toBe(join("/h", ".config", "opencode", "skill", "callyourcode"));
});

test("harnessCopyTargets: CYC_HOME suppresses the CODEX_HOME + XDG_CONFIG_HOME overrides, matching the installer", () => {
  // Installer: `XDG_CONFIG_HOME && !CYC_HOME ? ... : home/.config/opencode` and
  // `CODEX_HOME && !CYC_HOME ? ... : home/.codex` (harness-integration.ts:434,477).
  // Matrix over {XDG set?} x {CODEX set?} x {CYC_HOME set?}, asserting the heal
  // resolves the exact root the installer wrote.
  const dstOf = (opts: {
    codexHome?: string;
    xdgConfigHome?: string;
    cycHome?: string;
  }) => {
    const t = harnessCopyTargets({ home: "/h", engineRoot: "/repo/engine", ...opts });
    const byLabel = Object.fromEntries(t.map((x) => [x.label, x]));
    return {
      opencodeRoot: byLabel["opencode plugin"]!.dst,
      opencodeSkill: byLabel["opencode skill"]!.dst,
      codexRoot: byLabel["codex skill"]!.dst,
    };
  };

  // Overrides set, CYC_HOME unset: overrides win (installer honours them).
  const on = dstOf({ codexHome: "/custom/codex", xdgConfigHome: "/xdg" });
  expect(on.opencodeRoot).toBe("/xdg/opencode/plugin/callyourcode.ts");
  expect(on.opencodeSkill).toBe("/xdg/opencode/skill/callyourcode");
  expect(on.codexRoot).toBe("/custom/codex/skills/callyourcode");

  // Same overrides, but CYC_HOME set: BOTH suppressed, fall back to home defaults
  // (this is the byte-for-byte installer behaviour the heal must mirror).
  const off = dstOf({ codexHome: "/custom/codex", xdgConfigHome: "/xdg", cycHome: "/cychome" });
  expect(off.opencodeRoot).toBe(join("/h", ".config", "opencode", "plugin", "callyourcode.ts"));
  expect(off.opencodeSkill).toBe(join("/h", ".config", "opencode", "skill", "callyourcode"));
  expect(off.codexRoot).toBe(join("/h", ".codex", "skills", "callyourcode"));

  // CYC_HOME set with NO overrides: home defaults either way (no change vs above).
  const bare = dstOf({ cycHome: "/cychome" });
  expect(bare.opencodeRoot).toBe(join("/h", ".config", "opencode", "plugin", "callyourcode.ts"));
  expect(bare.codexRoot).toBe(join("/h", ".codex", "skills", "callyourcode"));

  // Only one override + CYC_HOME: that one is still suppressed independently.
  const xdgOnly = dstOf({ xdgConfigHome: "/xdg", cycHome: "/cychome" });
  expect(xdgOnly.opencodeRoot).toBe(join("/h", ".config", "opencode", "plugin", "callyourcode.ts"));
  const codexOnly = dstOf({ codexHome: "/custom/codex", cycHome: "/cychome" });
  expect(codexOnly.codexRoot).toBe(join("/h", ".codex", "skills", "callyourcode"));
});

test("healCopyTarget opencode skill: absent on a claude box stays absent (refresh-only never plants it)", () => {
  // Claude box: the installer wrote no opencode skill copy (opencode discovers
  // claude's). Listing the target is safe -- an absent dst is left untouched.
  const t = {
    kind: "dir" as const,
    label: "opencode skill",
    src: "/repo/engine/skills/callyourcode",
    dst: "/h/.config/opencode/skill/callyourcode",
  };
  const io = memIo({ "/repo/engine/skills/callyourcode/SKILL.md": "v2" }); // no dst
  const r = healCopyTarget(t, io);
  expect(r.changed).toBe(false);
  expect(r.note).toContain("absent");
  expect(io.writes).toEqual([]);
  expect("/h/.config/opencode/skill/callyourcode/SKILL.md" in io.files).toBe(false);
});

test("healHarnessCopiesAtBoot: on an opencode-only box the stale opencode skill copy is refreshed", () => {
  // Opencode-only box: no ~/.claude/skills copy, so the installer DID plant
  // <configRoot>/skill/callyourcode. Fail-before it drifted stale; the heal
  // refreshes it to the source bytes, and the absent claude/codex copies stay absent.
  const opts = { home: "/box", engineRoot: "/repo/engine", codexHome: "/box/codex", xdgConfigHome: "/box/xdg" };
  const targets = harnessCopyTargets(opts);
  const ocSkill = targets.find((t) => t.label === "opencode skill")!;
  const io = memIo({
    [join(ocSkill.src, "SKILL.md")]: "v2 announce",
    [join(ocSkill.dst, "SKILL.md")]: "v1 stale", // opencode-only copy exists, stale
  });
  // Fail-before: nothing has run, the copy is still the stale pre-announce byte.
  expect(io.files[join(ocSkill.dst, "SKILL.md")]).toBe("v1 stale");

  const logs: string[] = [];
  const results = healHarnessCopiesAtBoot((l) => logs.push(l), opts, io);

  const oc = results.find((r) => r.label === "opencode skill")!;
  expect(oc.changed).toBe(true);
  expect(io.files[join(ocSkill.dst, "SKILL.md")]).toBe("v2 announce");
  // The claude + codex skill copies were absent here and stay absent.
  expect(results.find((r) => r.label === "claude skill")!.note).toContain("absent");
  expect(results.find((r) => r.label === "codex skill")!.note).toContain("absent");
  // One log line, for the refreshed opencode skill.
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain(ocSkill.dst);
});

test("healCopyTarget file: a stale copy stays stale without the heal, then is rewritten to the source bytes", () => {
  const t = { kind: "file" as const, label: "opencode plugin", src: "/src/plugin.ts", dst: "/dst/plugin.ts" };
  const io = memIo({ "/src/plugin.ts": "NEW announce", "/dst/plugin.ts": "OLD (no announce)" });

  // Fail-before: nothing has run, so the copy is still the stale pre-announce byte.
  expect(io.files["/dst/plugin.ts"]).toBe("OLD (no announce)");

  const r = healCopyTarget(t, io);
  expect(r).toEqual({ changed: true, note: "refreshed stale copy" });
  expect(io.files["/dst/plugin.ts"]).toBe("NEW announce");
  expect(io.writes).toEqual(["/dst/plugin.ts"]);
});

test("healCopyTarget file: a current copy is untouched (no write)", () => {
  const t = { kind: "file" as const, label: "opencode plugin", src: "/src/plugin.ts", dst: "/dst/plugin.ts" };
  const io = memIo({ "/src/plugin.ts": "same", "/dst/plugin.ts": "same" });
  const r = healCopyTarget(t, io);
  expect(r).toEqual({ changed: false, note: "current" });
  expect(io.writes).toEqual([]);
});

test("healCopyTarget file: a MISSING copy is NOT created (refresh only)", () => {
  const t = { kind: "file" as const, label: "opencode plugin", src: "/src/plugin.ts", dst: "/dst/plugin.ts" };
  const io = memIo({ "/src/plugin.ts": "NEW" }); // no dst on disk
  const r = healCopyTarget(t, io);
  expect(r.changed).toBe(false);
  expect(r.note).toContain("absent");
  expect(io.writes).toEqual([]);
  expect("/dst/plugin.ts" in io.files).toBe(false);
});

test("healCopyTarget dir: stale file rewritten, new source file added, foreign copy-side file removed", () => {
  const t = { kind: "dir" as const, label: "claude skill", src: "/src/skill", dst: "/dst/skill" };
  const io = memIo({
    "/src/skill/SKILL.md": "v2",
    "/src/skill/PAGES.md": "brand new", // source-only: must be ADDED to the copy
    "/dst/skill/SKILL.md": "v1", // stale: must be REWRITTEN
    // /dst/skill/PAGES.md is absent on the copy side on purpose (see the add).
    "/dst/skill/OLD.md": "gone from source", // foreign: source is gone, must be REMOVED
  });

  const r = healCopyTarget(t, io);
  expect(r).toEqual({ changed: true, note: "refreshed stale copy" });
  expect(io.files["/dst/skill/SKILL.md"]).toBe("v2");
  expect(io.files["/dst/skill/PAGES.md"]).toBe("brand new");
  expect("/dst/skill/OLD.md" in io.files).toBe(false);
  expect(io.removes).toEqual(["/dst/skill/OLD.md"]);
});

test("healCopyTarget dir: a byte-identical copy is untouched (no write, no remove)", () => {
  const t = { kind: "dir" as const, label: "codex skill", src: "/src/skill", dst: "/dst/skill" };
  const io = memIo({
    "/src/skill/SKILL.md": "same",
    "/src/skill/CLI.md": "same2",
    "/dst/skill/SKILL.md": "same",
    "/dst/skill/CLI.md": "same2",
  });
  const r = healCopyTarget(t, io);
  expect(r).toEqual({ changed: false, note: "current" });
  expect(io.writes).toEqual([]);
  expect(io.removes).toEqual([]);
});

test("healCopyTarget dir: a MISSING copy dir is NOT created (refresh only)", () => {
  const t = { kind: "dir" as const, label: "claude skill", src: "/src/skill", dst: "/dst/skill" };
  const io = memIo({ "/src/skill/SKILL.md": "v2" }); // no dst dir at all
  const r = healCopyTarget(t, io);
  expect(r.changed).toBe(false);
  expect(r.note).toContain("absent");
  expect(io.writes).toEqual([]);
});

test("healHarnessCopiesAtBoot: repairs only the drifted copies, one log line each, silent for current, none created for absent", () => {
  // Full opts (codex/xdg pinned) so the wrapper does not read the ambient env.
  const opts = { home: "/box", engineRoot: "/repo/engine", codexHome: "/box/codex", xdgConfigHome: "/box/xdg" };
  const targets = harnessCopyTargets(opts);
  const plugin = targets.find((t) => t.label === "opencode plugin")!;
  const claude = targets.find((t) => t.label === "claude skill")!;
  // opencode plugin copy: stale, will be repaired.
  // claude skill copy: current, silent.
  // codex skill copy: absent on this box, must NOT be created.
  const io = memIo({
    [plugin.src]: "NEW announce",
    [plugin.dst]: "OLD",
    [join(claude.src, "SKILL.md")]: "same",
    [join(claude.dst, "SKILL.md")]: "same",
  });
  const logs: string[] = [];
  const results = healHarnessCopiesAtBoot((l) => logs.push(l), opts, io);

  expect(results.find((r) => r.label === "opencode plugin")!.changed).toBe(true);
  expect(results.find((r) => r.label === "claude skill")!.changed).toBe(false);
  const codex = results.find((r) => r.label === "codex skill")!;
  expect(codex.changed).toBe(false);
  expect(codex.note).toContain("absent");

  // One clear log line, for the repaired path only.
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain(plugin.dst);
  // The stale copy is now the source bytes; the absent codex copy was never made.
  expect(io.files[plugin.dst]).toBe("NEW announce");
  expect(targets.find((t) => t.label === "codex skill")!.dst in io.files).toBe(false);
});

test("healHarnessCopiesAtBoot: one target's error is logged and skipped, the rest still heal (fail-safe)", () => {
  const opts = { home: "/box", engineRoot: "/repo/engine", codexHome: "/box/codex", xdgConfigHome: "/box/xdg" };
  const targets = harnessCopyTargets(opts);
  const plugin = targets.find((t) => t.label === "opencode plugin")!;
  const claude = targets.find((t) => t.label === "claude skill")!;
  const io = memIo({
    [plugin.src]: "NEW",
    [plugin.dst]: "OLD",
    [join(claude.src, "SKILL.md")]: "v2",
    [join(claude.dst, "SKILL.md")]: "v1",
  });
  // Make the claude-skill heal throw when it reads the source file, leaving the
  // plugin heal to succeed on its own.
  const realRead = io.read;
  io.read = (p: string) => {
    if (p === join(claude.src, "SKILL.md")) throw new Error("boom");
    return realRead(p);
  };
  const logs: string[] = [];
  const results = healHarnessCopiesAtBoot((l) => logs.push(l), opts, io);

  // The plugin was still refreshed despite the claude-skill target throwing.
  expect(io.files[plugin.dst]).toBe("NEW");
  const claudeRes = results.find((r) => r.label === "claude skill")!;
  expect(claudeRes.changed).toBe(false);
  expect(claudeRes.note).toContain("heal skipped");
  // The stale claude copy was left as-is (not half-written).
  expect(io.files[join(claude.dst, "SKILL.md")]).toBe("v1");
  // Two log lines: the repaired plugin, and the skipped-with-error claude skill.
  expect(logs.some((l) => l.includes(plugin.dst) && l.includes("refreshed"))).toBe(true);
  expect(logs.some((l) => l.includes(claude.dst) && l.includes("heal skipped"))).toBe(true);
});
