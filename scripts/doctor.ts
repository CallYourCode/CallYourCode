/* `cyc doctor`: the second-instance debugger. It reads the engine identity and
 * ports from every place they can be set, names any DISAGREEMENT, resolves what
 * THIS process would use, and round-trips the local engine over its socket with
 * side-effect-free probes. Exit 1 on any DIFF or any FAILED leg, so it is a
 * usable gate ("cyc doctor && ...") and not just a report.
 *
 * The pure parts (unit-env parsing, the diff, the bun-version note) are exported
 * and unit-tested; runDoctor takes its IO (command runner, file reader, the
 * engine fetch) as injected deps so the round-trip test drives it against a
 * throwaway engine on a temp socket and asserts no session was minted.
 */

import {
  resolveEngine, engineFetch, engineLabel, defaultSockPath,
  type EngineTarget, type EngineEnv,
} from "../engine/shared/engine-url.ts";
import { resolvePorts } from "../engine/shared/ports.ts";

/* The three fields a second instance gets wrong, and the ones this tool tracks
 * across every config location. */
export const DOCTOR_KEYS = ["CYC_ENGINE_URL", "AGENT_PORT", "VOICE_ENGINE_URL"] as const;
export type DoctorKey = (typeof DOCTOR_KEYS)[number];

export type ConfigSource = { name: string; env: Record<string, string | undefined> };

/** Pull KEY=VALUE pairs from a `systemctl --user cat <unit>` dump: only the
 *  `Environment=` lines (an EnvironmentFile= is a path, not values, so it is
 *  left for the show-environment source to reflect). A quoted or bare value is
 *  taken verbatim after the first `=`; systemd allows several on one line but
 *  the units this repo writes use one per line, which is what we read. */
export function unitEnvFromCat(catText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of catText.split("\n")) {
    const line = raw.trim();
    const m = /^Environment=(?:"?)([^=]+)=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2];
    if (val.endsWith('"')) val = val.slice(0, -1); // strip a trailing quote from Environment="K=V"
    out[key] = val;
  }
  return out;
}

/** Parse `systemctl --user show-environment` output (KEY=VALUE per line). */
export function showEnvironment(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** The tracked keys of one source, undefined for any it does not set. */
export function keysOf(env: Record<string, string | undefined>): Record<DoctorKey, string | undefined> {
  return {
    CYC_ENGINE_URL: env.CYC_ENGINE_URL,
    AGENT_PORT: env.AGENT_PORT,
    VOICE_ENGINE_URL: env.VOICE_ENGINE_URL,
  };
}

/** DIFF lines: for each tracked key, if two sources DEFINE it to different
 *  values, name the disagreement. A key only one source sets is not a diff (it
 *  is just where it lives); a key nobody sets is silent. */
export function diffLines(sources: ConfigSource[]): string[] {
  const lines: string[] = [];
  for (const key of DOCTOR_KEYS) {
    const seen = new Map<string, string[]>(); // value -> source names
    for (const s of sources) {
      const v = s.env[key];
      if (v === undefined || v === "") continue;
      (seen.get(v) ?? seen.set(v, []).get(v)!).push(s.name);
    }
    if (seen.size > 1) {
      const parts = [...seen.entries()].map(([v, names]) => `${names.join("+")}=${v}`);
      lines.push(`DIFF ${key}: ${parts.join(" vs ")}`);
    }
  }
  return lines;
}

/** The bun-version note: a WARN string, or null when it is the pinned 1.4.0. */
export function bunVersionNote(version: string): string | null {
  const v = version.trim();
  if (v === "1.4.2") {
    return "WARN bun 1.4.2 is known-bad (TTS worker DataCloneError); pin bun-v1.4.0";
  }
  if (v !== "1.4.0") return `WARN bun ${v} is not the pinned 1.4.0`;
  return null;
}

/* ------------------------------------------------------------------ runDoctor */

export type DoctorIO = {
  /** Run a command, returning its stdout (empty string on any failure). */
  run: (cmd: string, args: string[]) => Promise<string>;
  /** Read a text file, or null when it is absent/unreadable. */
  readFile: (path: string) => Promise<string | null>;
  /** fetch against an engine target (defaults to the real engineFetch). */
  fetch?: (t: EngineTarget, path: string, init?: RequestInit) => Promise<Response>;
  bunVersion: string;
  home: string;
};

export type DoctorResult = { text: string; code: number };

async function leg(
  label: string, fn: () => Promise<{ ok: boolean; note: string }>,
): Promise<{ line: string; ok: boolean }> {
  try {
    const r = await fn();
    return { line: `  ${r.ok ? "PASS" : "FAIL"} ${label}${r.note ? ` (${r.note})` : ""}`, ok: r.ok };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { line: `  FAIL ${label} (${m})`, ok: false };
  }
}

export async function runDoctor(env: EngineEnv, io: DoctorIO): Promise<DoctorResult> {
  const fetchFn = io.fetch ?? engineFetch;
  const out: string[] = [];

  // --- 1. CONFIG: where the identity/ports are set, and any disagreement -----
  out.push("CONFIG");
  const unitCat = await io.run("systemctl", ["--user", "cat", "cyc-agent-engine"]);
  const showEnv = await io.run("systemctl", ["--user", "show-environment"]);
  const unitEnv = { ...showEnvironment(showEnv), ...unitEnvFromCat(unitCat) };

  const settingsText = await io.readFile(`${io.home}/.claude/settings.json`);
  const settingsEnv = jsonEnv(settingsText, (d) => d?.env);

  const claudeJsonText = await io.readFile(`${io.home}/.claude.json`);
  const mcpEnv = jsonEnv(claudeJsonText, (d) => d?.mcpServers?.callyourcode?.env);

  const sources: ConfigSource[] = [
    { name: "units", env: unitEnv },
    { name: "settings.json", env: settingsEnv },
    { name: "mcp.callyourcode", env: mcpEnv },
  ];
  for (const s of sources) {
    const k = keysOf(s.env);
    out.push(`  ${s.name}: ` + DOCTOR_KEYS.map((key) => `${key}=${k[key] ?? "(unset)"}`).join("  "));
  }
  const diffs = diffLines(sources);
  for (const d of diffs) out.push("  " + d);

  // --- 2. RESOLVED: what THIS process env yields, plus the bun check ---------
  out.push("");
  out.push("RESOLVED");
  const target = resolveEngine(env);
  const ports = resolvePorts(env);
  out.push(`  engine: ${engineLabel(target)}`);
  out.push(`  ports:  APP=${ports.APP_PORT} AGENT=${ports.AGENT_PORT} VOICE=${ports.VOICE_PORT} TURN=${ports.TURN_PORT}`);
  const bunNote = bunVersionNote(io.bunVersion);
  out.push(`  bun:    ${io.bunVersion}${bunNote ? ` -- ${bunNote}` : " (pinned)"}`);

  // --- 3. ROUND-TRIP: socket health, then the two probe posts ---------------
  out.push("");
  out.push("ROUND-TRIP");
  const socketTarget: EngineTarget = { kind: "unix", path: defaultSockPath(env) };
  const legs: { line: string; ok: boolean }[] = [];

  legs.push(await leg(`socket /health (${socketTarget.path})`, async () => {
    const res = await fetchFn(socketTarget, "/health");
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && (body as { ok?: boolean }).ok === true, note: `HTTP ${res.status}` };
  }));

  legs.push(await leg("announce probe", async () => {
    const res = await fetchFn(target, "/harness/announce", probePost());
    const body = await res.json().catch(() => ({}));
    const ok = res.ok && (body as { probe?: boolean }).probe === true;
    return { ok, note: `HTTP ${res.status}` };
  }));

  legs.push(await leg("reply probe", async () => {
    const res = await fetchFn(target, "/agent/reply", probePost());
    const body = await res.json().catch(() => ({}));
    const ok = res.ok && (body as { probe?: boolean }).probe === true;
    return { ok, note: `HTTP ${res.status}` };
  }));

  for (const l of legs) out.push(l.line);

  const failed = legs.some((l) => !l.ok) || diffs.length > 0;
  return { text: out.join("\n"), code: failed ? 1 : 0 };
}

function probePost(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: true }),
  };
}

/** Read a JSON file's text and pull an env-like object out of it via `pick`,
 *  returning {} for absent/garbage/non-object -- doctor reports "(unset)" then,
 *  never a crash. */
function jsonEnv(
  text: string | null, pick: (d: any) => unknown,
): Record<string, string | undefined> {
  if (!text || !text.trim()) return {};
  let data: unknown;
  try { data = JSON.parse(text); } catch { return {}; }
  const env = pick(data);
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
