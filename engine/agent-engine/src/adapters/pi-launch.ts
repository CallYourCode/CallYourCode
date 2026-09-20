// pi-launch: the launch-command augmentation that turns a plain pi launch into
// one that ALSO streams live events to cyc over a unix socket (the pi output
// extension, engine/harness/pi/cyc-output.js).
//
// ADDITIVE BY CONSTRUCTION. This only ever touches a pi launch, and only adds:
// a `CYC_PI_EVENT_SOCK` env assignment and a `-e <ext>` flag. Every other
// harness's command comes back byte-identical, so claude/codex/opencode
// launches are untouched. If the augmentation is absent (an old engine, a
// hand-started pi), the extension no-ops and the transcript reader covers the
// pane exactly as before -- the transcript path stays the source of truth.
//
// The socket path is per-pane and short (sun_path is ~108 bytes), keyed by the
// stable agent id the engine already mints for the pane, so the consumer that
// binds the server and the launch that points the extension at it agree on one
// name without a round trip.

import { join, dirname } from "node:path";

/** The env var cyc sets so the extension knows where to connect. */
export const PI_EVENT_SOCK_ENV = "CYC_PI_EVENT_SOCK";

/** The pi output extension pi loads with `-e`. It lives beside the engine
 *  (engine/harness/pi/cyc-output.js), three dirs up from src/adapters. The
 *  pi reader points its launchAugment at this path; it used to live in
 *  mux-adapter.ts, moved here so the pi-launch module owns the whole pi launch
 *  decoration. `dirname(import.meta.dir)` is `.../agent-engine/src` from this
 *  file (src/adapters), so the resolved path is `.../engine/harness/pi`. */
export const PI_EXTENSION_PATH = join(dirname(import.meta.dir), "..", "..", "harness", "pi", "cyc-output.js");

/** The pi launch program, as the pi reader spells it (readers/pi.ts launch):
 *  the shipped `pi` binary. A path form (`.../bin/pi`, e.g. /usr/bin/pi) counts
 *  too. */
const PI_PROGRAM_RE = /(?:^|\/)pi$/;

/** Strip leading `env NAME=VALUE ...` assignments (and a bare `env`) so the
 *  first real token is the program. Mirrors how the engine prefixes a launch
 *  with `env CYC_AGENT_ID=... <cmd>` (runtime/agent-env.ts). Also the
 *  availability probe's reader->binary map (routes/session-ops.ts): the first
 *  program token of a reader's launch command is what must resolve on PATH. */
export function programToken(command: string): string | null {
  const toks = command.trim().split(/\s+/);
  let i = 0;
  if (toks[i] === "env") i++;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  return toks[i] ?? null;
}

/** True when this launch command starts a pi pane (its program is pi). The
 *  command may carry an `env NAME=VALUE` prefix; only the program decides. */
export function isPiLaunchCommand(command: string): boolean {
  const prog = programToken(command);
  return prog != null && PI_PROGRAM_RE.test(prog);
}

/** Single-quote a value for a POSIX command line. Engine-controlled absolute
 *  paths only, but quoting keeps a space or an odd char from splitting a
 *  token. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The per-pane socket path under a run dir, keyed by the pane's stable id.
 *  The key is held to a filename-safe charset so it can never escape the dir
 *  or inject a path segment. */
export function piEventSockPath(runDir: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "");
  return join(runDir, `pi-evt-${safe}.sock`);
}

export type PiLaunchAugmentation = {
  /** the launch command to run (augmented for pi, unchanged otherwise) */
  command: string;
  /** the socket path the engine must bind before launching, or null when this
   *  is not a pi launch (nothing to bind) */
  sockPath: string | null;
};

/** Augment a launch command so a cyc-launched pi streams events to `sockPath`.
 *  Non-pi commands pass through untouched with a null sockPath. For pi it adds
 *  a `CYC_PI_EVENT_SOCK=<sock>` assignment and a trailing `-e <extensionPath>`
 *  flag (both are plain pi flags/env, passed straight to the real binary). */
export function augmentPiLaunch(
  command: string,
  opts: { extensionPath: string; sockPath: string },
): PiLaunchAugmentation {
  if (!isPiLaunchCommand(command)) return { command, sockPath: null };
  const env = `env ${PI_EVENT_SOCK_ENV}=${sq(opts.sockPath)} `;
  const withExt = `${command.trim()} -e ${sq(opts.extensionPath)}`;
  return { command: env + withExt, sockPath: opts.sockPath };
}
