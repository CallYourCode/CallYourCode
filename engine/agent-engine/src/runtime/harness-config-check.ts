/* THE BOOT SELF-CHECK for a harness's cyc wiring (the config-portable footgun).
 *
 * A harness is wired to the engine through its OWN config -- claude's
 * ~/.claude.json + ~/.claude/settings.json, codex's config.toml + hooks.json,
 * opencode's opencode.json. Historically each of those hardcoded an ABSOLUTE
 * path to this checkout (engine/mcp/src/server.ts, engine/hooks/*.py, ...).
 * Copied across machines, or after the engine dir moves, that path is dead:
 * the cyc MCP fails to start and the hooks fail to run -- and it fails SILENTLY
 * for claude text (its replies ride the JSONL transcript, no MCP/hook needed)
 * while it kills voice self-identify + codex's entire outbound reply path.
 *
 * The launcher wiring (`cyc mcp` / `cyc hook <name>`, scripts/cyc.ts) removes
 * the footgun for freshly written configs, but a config from BEFORE that change
 * (or a codex config.toml, which is append-only and not migrated in place) can
 * still carry a dead absolute path. This check reads each present harness config
 * at boot and WARNS -- naming the harness, the file and the dead path -- so a
 * silently-dead voice/codex is a visible diagnostic instead of a mystery.
 *
 * It only ever READS host configs; it never writes one. The scan is precise: it
 * looks only at absolute paths under `/engine/` whose basename is one of THIS
 * project's wired scripts, so a foreign MCP server's own path is never flagged.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { codexConfigPath } from "../adapters/trust-folder.ts";

/** The scripts a harness config wires into this engine, by basename. A path is
 *  only a candidate when it is absolute, sits under `/engine/`, and ends in one
 *  of these -- so an unrelated server.ts (a foreign mcp) is never mistaken for
 *  ours. */
export const WIRED_SCRIPTS = new Set([
  "server.ts",
  "enforce-voice-reply.py",
  "enforce-bash-async.py",
  "enforce-shell-async.py",
  "announce-session.py",
]);

export type HarnessPathWarning = { harness: string; file: string; path: string };

/** Every absolute cyc-wiring path a config text names, deduped. Catches the
 *  forms all three harnesses use: JSON args arrays, `python3 <abspath>` hook
 *  command strings, and TOML `args = ["<abspath>"]`. The launcher forms
 *  (`cyc mcp`, `cyc hook ...`) carry NO absolute path, so they yield nothing --
 *  which is exactly why they are immune to this footgun. */
export function wiredPathsIn(text: string): string[] {
  const out = new Set<string>();
  // An absolute path token: up to the next whitespace, quote, comma or bracket.
  for (const m of text.matchAll(/\/[^\s"'`,\])]+\.(?:ts|py)/g)) {
    const p = m[0];
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (p.includes("/engine/") && WIRED_SCRIPTS.has(base)) out.add(p);
  }
  return [...out];
}

/** Scan one config file's text for cyc-wiring paths that do not resolve on this
 *  machine. `exists` is injected so tests drive it with fixtures. */
export function scanConfig(
  harness: string,
  file: string,
  text: string,
  exists: (p: string) => boolean,
): HarnessPathWarning[] {
  return wiredPathsIn(text)
    .filter((p) => !exists(p))
    .map((p) => ({ harness, file, path: p }));
}

/** The config files each harness wires, given a home (+ optional codex/xdg
 *  overrides). Only the harness's identity and file paths; existence is checked
 *  by the caller so this stays pure. */
export function harnessConfigFiles(opts: {
  home: string;
  codexHome?: string;
  xdgConfigHome?: string;
}): { harness: string; file: string }[] {
  const { home } = opts;
  const codex = opts.codexHome || join(home, ".codex");
  const opencodeRoot = opts.xdgConfigHome
    ? join(opts.xdgConfigHome, "opencode")
    : join(home, ".config", "opencode");
  return [
    { harness: "claude", file: join(home, ".claude.json") },
    { harness: "claude", file: join(home, ".claude", "settings.json") },
    { harness: "opencode", file: join(opencodeRoot, "opencode.json") },
    { harness: "codex", file: join(codex, "config.toml") },
    { harness: "codex", file: join(codex, "hooks.json") },
  ];
}

/** The whole check: every present harness config, scanned for dead cyc paths.
 *  `read`/`exists` are injected (tests use fixtures; boot uses node:fs). A file
 *  that is absent or unreadable is skipped -- absence is not a wiring fault. */
export function checkHarnessConfigs(
  opts: { home: string; codexHome?: string; xdgConfigHome?: string },
  io: { exists: (p: string) => boolean; read: (p: string) => string | null },
): HarnessPathWarning[] {
  const warnings: HarnessPathWarning[] = [];
  for (const { harness, file } of harnessConfigFiles(opts)) {
    if (!io.exists(file)) continue;
    let text: string | null;
    try {
      text = io.read(file);
    } catch {
      continue; // unreadable: not this check's business
    }
    if (text == null) continue;
    warnings.push(...scanConfig(harness, file, text, io.exists));
  }
  return warnings;
}

/** Boot entry: run the check against the real host configs and log a clear
 *  warning per dead path. Reads only; never writes. Wrapped so a check failure
 *  never takes boot down. Returns the warnings (for the caller/tests). */
export function warnOnDeadHarnessPaths(log: (line: string) => void = console.warn): HarnessPathWarning[] {
  let warnings: HarnessPathWarning[] = [];
  try {
    warnings = checkHarnessConfigs(
      {
        home: homedir(),
        codexHome: process.env.CODEX_HOME || undefined,
        xdgConfigHome: process.env.XDG_CONFIG_HOME || undefined,
      },
      {
        exists: (p) => existsSync(p),
        read: (p) => readFileSync(p, "utf-8"),
      },
    );
  } catch {
    return warnings;
  }
  for (const w of warnings) {
    log(
      `[harness-check] ${w.harness} config ${w.file} wires a cyc path that does not exist here: ${w.path} ` +
        `-- the engine moved or this config was copied from another machine, so voice/codex may be silently dead. ` +
        `Re-run \`cyc install\` to rewire it to the path-independent launcher.`,
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// SELF-HEAL: the one config the installer cannot migrate in place.
//
// claude's ~/.claude.json and opencode's opencode.json are JSON, so the
// installer rewrites a stale absolute `bun .../server.ts` to the path-free
// `cyc mcp` launcher (mergeClaudeJson / mergeOpencodeConfig). codex's
// config.toml is TOML, which the installer refuses to rewrite (not
// round-trippable with a naive parser -- mergeCodexToml leaves an existing
// [mcp_servers.callyourcode] byte-for-byte intact). So when the engine dir
// moves (or the config is copied across machines), codex's mcp path is the ONE
// wiring that drifts dead and is never repaired: the boot check above only
// WARNS. This is exactly the drift the user hit (config.toml pointed at a dead
// engine/mcp/callyourcode-mcp.ts).
//
// The heal converts that ONE section to the launcher form (`command = "cyc"`,
// `args = ["mcp"]`), the same path-free wiring the JSON harnesses already carry
// -- so it is immune to the footgun forever, not just repaired to a fresh
// absolute path that would drift again on the next move. The [mcp_servers.
// callyourcode] header positively identifies the section as OURS, so a foreign
// mcp server is never touched. Surgical + idempotent + never throws, in the
// spirit of adapters/trust-folder.ts (which already writes this same file).

const LAUNCHER_BODY = 'command = "cyc"\nargs = ["mcp"]';

/** Repair the codex `[mcp_servers.callyourcode]` section in TOML `text` to the
 *  path-free `cyc mcp` launcher. Line-based so the rest of the file is preserved
 *  byte-for-byte. Idempotent: already-launcher is a no-op; a foreign command or
 *  a section with no absolute path is left alone. `exists` only enriches the
 *  note (dead vs still-portable-but-fragile); the section is repaired either way
 *  because a live absolute path drifts dead on the next engine move. Pure, for
 *  the unit test; the boot wrapper injects real fs. */
export function repairCodexMcpToml(
  text: string,
  exists: (p: string) => boolean,
): { text: string; changed: boolean; note: string } {
  const lines = text.split("\n");
  const hIdx = lines.findIndex((l) => /^\s*\[mcp_servers\.callyourcode\]\s*$/.test(l));
  if (hIdx === -1) return { text, changed: false, note: "no [mcp_servers.callyourcode] section" };

  // The section body runs to the next table header (subtables included) or EOF.
  let end = hIdx + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  const body = lines.slice(hIdx + 1, end).join("\n");

  const isLauncher = /command\s*=\s*"cyc"/.test(body) && /args\s*=\s*\[\s*"mcp"\s*\]/.test(body);
  if (isLauncher) return { text, changed: false, note: "already on `cyc mcp`" };

  const abs = body.match(/\/[^\s"'`,\])]+\.ts/);
  if (!abs) return { text, changed: false, note: "no absolute path to repair" };

  const state = exists(abs[0]) ? "portable" : "dead";
  const rebuilt = [
    ...lines.slice(0, hIdx + 1),
    LAUNCHER_BODY,
    ...(end < lines.length ? [""] : []), // keep a blank line before the next table
    ...lines.slice(end),
  ];
  return {
    text: rebuilt.join("\n"),
    changed: true,
    note: `repaired ${state} [mcp_servers.callyourcode] path ${abs[0]} -> \`cyc mcp\``,
  };
}

/** Boot entry: heal the codex config.toml mcp path in place if it drifted.
 *  Reads/writes the real host config (CODEX_HOME honored, via trust-folder's
 *  codexConfigPath). Writes ONLY when something changed; wrapped so a heal fault
 *  never takes boot down. Returns the note (for the caller/tests). */
export function healCodexMcpPathAtBoot(
  log: (line: string) => void = console.warn,
  io: {
    exists: (p: string) => boolean;
    read: (p: string) => string | null;
    write: (p: string, text: string) => void;
    path: () => string;
  } = {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, "utf-8"),
    write: (p, text) => writeFileSync(p, text),
    path: () => codexConfigPath(),
  },
): { changed: boolean; note: string } {
  try {
    const file = io.path();
    if (!io.exists(file)) return { changed: false, note: "no codex config.toml" };
    const text = io.read(file);
    if (text == null) return { changed: false, note: "codex config.toml unreadable" };
    const r = repairCodexMcpToml(text, io.exists);
    if (!r.changed) return { changed: false, note: r.note };
    io.write(file, r.text);
    log(`[harness-check] ${file}: ${r.note}`);
    return { changed: true, note: r.note };
  } catch (e) {
    return { changed: false, note: `heal skipped: ${(e as Error)?.message}` };
  }
}

// ---------------------------------------------------------------------------
// SELF-HEAL: the harness-side artifacts the installer COPIES out of the repo.
//
// Most cyc wiring points INTO the checkout through a launcher (`cyc mcp`,
// `cyc hook <name>`), so a deploy that moves the engine dir keeps working and
// the checks above only guard the config-portable footgun. But four artifacts
// are physically COPIED out of the repo by the installer, not wired, so a deploy
// never refreshes them and they drift stale silently:
//
//   engine/harness/opencode/callyourcode.ts -> <opencode>/plugin/callyourcode.ts   (one file, always)
//   engine/skills/callyourcode/             -> <claude>/.claude/skills/callyourcode/ (a dir, when claude present)
//   engine/skills/callyourcode/             -> <codex>/skills/callyourcode/          (a dir, when codex present)
//   engine/skills/callyourcode/             -> <opencode>/skill/callyourcode/         (a dir, opencode-only boxes)
//
// FIELD EVIDENCE: a box's plugin copy predated the session-announce entirely, so
// opencode never bound its session until the copy was refreshed by hand. (The
// owner's call, 2026-09-20: deploys must self-heal these copies at engine boot,
// the way repairCodexMcpToml self-heals codex's config.toml above.)
//
// REFRESH ONLY, never install: a copy that is ABSENT stays absent -- the
// installer owns creation. The opencode skill copy exists only on opencode-only
// boxes (on a claude box opencode auto-discovers claude's skills, so the
// installer writes no opencode copy); refresh-only means listing it is safe
// either way -- absent stays absent, present-but-stale gets refreshed. The file copy is
// compared byte-for-byte; each dir copy is compared per file -- a source file
// missing from the copy is added, a changed one is rewritten, and a copy-side
// file whose source is gone is removed. Fail-safe: any error is logged and
// skipped so boot never breaks; one clear log line per repaired path, silent
// when a copy is already current.

/** One artifact the installer copies out of the repo, and where it lands. `file`
 *  is a single file; `dir` is a directory compared per file. */
export type HarnessCopy = {
  kind: "file" | "dir";
  label: string;
  src: string;
  dst: string;
};

/** The four copies the installer plants, with destinations resolved the way the
 *  installer resolves them (home, CODEX_HOME, XDG_CONFIG_HOME overrides).
 *  `engineRoot` is the engine's own dir (<repo>/engine), from which both repo
 *  sources hang. Pure: existence is checked by the healer, so this just names
 *  paths.
 *
 *  The CODEX_HOME / XDG_CONFIG_HOME overrides are SUPPRESSED when CYC_HOME is set,
 *  byte-for-byte matching the installer (scripts/harness-integration.ts:434,477)
 *  -- so the heal can never resolve a different root than the installer wrote. */
export function harnessCopyTargets(opts: {
  home: string;
  engineRoot: string;
  codexHome?: string;
  xdgConfigHome?: string;
  cycHome?: string;
}): HarnessCopy[] {
  const { home, engineRoot } = opts;
  // Mirror the installer exactly: CYC_HOME suppresses the CODEX_HOME/XDG overrides.
  const codex = opts.codexHome && !opts.cycHome ? opts.codexHome : join(home, ".codex");
  const opencodeRoot =
    opts.xdgConfigHome && !opts.cycHome
      ? join(opts.xdgConfigHome, "opencode")
      : join(home, ".config", "opencode");
  const skillSrc = join(engineRoot, "skills", "callyourcode");
  return [
    {
      kind: "file",
      label: "opencode plugin",
      src: join(engineRoot, "harness", "opencode", "callyourcode.ts"),
      dst: join(opencodeRoot, "plugin", "callyourcode.ts"),
    },
    { kind: "dir", label: "claude skill", src: skillSrc, dst: join(home, ".claude", "skills", "callyourcode") },
    { kind: "dir", label: "codex skill", src: skillSrc, dst: join(codex, "skills", "callyourcode") },
    // The FOURTH copy: the installer plants a standalone opencode skill dir ONLY on
    // opencode-only boxes (when ~/.claude/skills/callyourcode is absent, so opencode
    // has no claude copy to auto-discover -- harness-integration.ts:461-471). Because
    // the heal is REFRESH-ONLY it is safe to list unconditionally: on a claude box
    // where the installer never wrote it, the dst is absent and refresh-only leaves it
    // absent (no stray second copy); on an opencode-only box the installer did write it
    // and the heal now refreshes it when stale, closing the last unhealed copy.
    {
      kind: "dir",
      label: "opencode skill",
      src: skillSrc,
      dst: join(opencodeRoot, "skill", "callyourcode"),
    },
  ];
}

/** The filesystem a copy-heal needs, injected so the tests drive it with an
 *  in-memory fixture. `listFiles` returns the relative paths of every file under
 *  a dir (recursive). */
export type CopyIo = {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, text: string) => void;
  remove: (p: string) => void;
  listFiles: (dir: string) => string[];
};

/** Refresh ONE copy against its source. REFRESH-ONLY: a `dst` that does not
 *  exist is left untouched (the installer owns creation; opencode's absent skill
 *  is deliberate). A file copy is rewritten only when the bytes differ; a dir
 *  copy adds/rewrites source files and removes copy-side files whose source is
 *  gone. If the SOURCE is missing there is nothing to refresh from, so the copy
 *  is left as-is. Pure over the injected io; throws are the boot wrapper's to
 *  catch. */
export function healCopyTarget(t: HarnessCopy, io: CopyIo): { changed: boolean; note: string } {
  if (!io.exists(t.dst)) return { changed: false, note: "absent (not installed here); left as-is" };
  if (!io.exists(t.src)) return { changed: false, note: "repo source missing; left as-is" };

  if (t.kind === "file") {
    if (io.read(t.src) === io.read(t.dst)) return { changed: false, note: "current" };
    io.write(t.dst, io.read(t.src));
    return { changed: true, note: "refreshed stale copy" };
  }

  // dir: compare per file.
  const srcFiles = new Set(io.listFiles(t.src));
  const dstFiles = new Set(io.listFiles(t.dst));
  let changed = false;
  for (const rel of srcFiles) {
    const s = io.read(join(t.src, rel));
    if (!dstFiles.has(rel) || io.read(join(t.dst, rel)) !== s) {
      io.write(join(t.dst, rel), s);
      changed = true;
    }
  }
  for (const rel of dstFiles) {
    if (!srcFiles.has(rel)) {
      io.remove(join(t.dst, rel));
      changed = true;
    }
  }
  return changed ? { changed: true, note: "refreshed stale copy" } : { changed: false, note: "current" };
}

/** The engine's own dir (<repo>/engine), from which the repo sources hang. Same
 *  derivation shape ENGINE_REPO uses in server.ts: walk up from this runtime
 *  dir. This file lives at engine/agent-engine/src/runtime, so three parents up
 *  is engine/. */
function defaultEngineRoot(): string {
  return dirname(dirname(dirname(import.meta.dir)));
}

/** The real host filesystem, for boot. `write` makes parent dirs so a new file
 *  in a nested source dir lands; it never creates the top-level copy dir on its
 *  own because healCopyTarget refuses to touch an absent `dst`. */
function realCopyIo(): CopyIo {
  const listFiles = (dir: string, base: string = dir): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
      else out.push(relative(base, full));
    }
    return out;
  };
  return {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, "utf-8"),
    write: (p, text) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    remove: (p) => rmSync(p, { force: true }),
    listFiles: (dir) => listFiles(dir),
  };
}

/** Boot entry: refresh every harness-side copy that already exists on disk from
 *  its repo source. Reads/writes the real host copies (home, CODEX_HOME,
 *  XDG_CONFIG_HOME honored); the source root is the engine's own dir. Writes ONLY
 *  when a copy drifted; each repaired path gets one log line, a current copy is
 *  silent. Fail-safe per target: one target's error is logged and skipped so the
 *  rest still heal and boot never breaks. Returns the per-target results (for the
 *  caller/tests). */
export function healHarnessCopiesAtBoot(
  log: (line: string) => void = console.warn,
  opts: { home?: string; engineRoot?: string; codexHome?: string; xdgConfigHome?: string; cycHome?: string } = {},
  io: CopyIo = realCopyIo(),
): { label: string; changed: boolean; note: string }[] {
  const results: { label: string; changed: boolean; note: string }[] = [];
  let targets: HarnessCopy[];
  try {
    targets = harnessCopyTargets({
      home: opts.home ?? (process.env.HOME || homedir()),
      engineRoot: opts.engineRoot ?? defaultEngineRoot(),
      codexHome: opts.codexHome ?? process.env.CODEX_HOME ?? undefined,
      xdgConfigHome: opts.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? undefined,
      cycHome: opts.cycHome ?? process.env.CYC_HOME ?? undefined,
    });
  } catch (e) {
    log(`[harness-check] copy-heal skipped: ${(e as Error)?.message}`);
    return results;
  }
  for (const t of targets) {
    try {
      const r = healCopyTarget(t, io);
      results.push({ label: t.label, ...r });
      if (r.changed) log(`[harness-check] ${t.dst}: ${r.note} from ${t.src}`);
    } catch (e) {
      const note = `heal skipped: ${(e as Error)?.message}`;
      results.push({ label: t.label, changed: false, note });
      log(`[harness-check] ${t.dst}: ${note}`);
    }
  }
  return results;
}
