/* WHICH PANE THIS MCP REPLIES FOR, recovered even when the harness scrubbed it.
 *
 * The engine routes a reply by pane id, and this process normally learns its id
 * from its OWN environment (HERDR_PANE_ID / VOICE_SESSION_ID / TMUX_PANE). herdr
 * and engine-launched panes stamp it there, so that path is first and stays
 * exactly as it was. But some harnesses (codex) spawn their MCP subprocess with
 * a SCRUBBED env: the harness process itself carries TMUX_PANE=%N, the child it
 * launches carries none of the three. With no id the output tools refuse and
 * every reply over tmux is lost.
 *
 * So when our OWN env yields nothing, walk UP the process ancestry and read each
 * ancestor's environment, taking the first pane id one carries. The parent is
 * the harness, whose env still has the pane. The reads mirror agents.ts's
 * resolveProcExe: Linux reads /proc directly, macOS shells out to ps, and both
 * are hidden behind an injectable resolver so tests need no real processes.
 */

import { readFileSync } from 'fs'

/** How the walk-up reads the process table. Injected so a test can map pids to
 *  fixed {ppid, env} without spawning anything; the default hits /proc (Linux)
 *  or ps (macOS). Either method returns null when it cannot read a pid, and the
 *  walk simply stops -- it never throws. */
export interface ProcResolver {
  /** The environment of a pid as KEY->VAL, or null when it cannot be read. */
  env(pid: number): Record<string, string> | null
  /** The parent pid of a pid, or null when it cannot be read. */
  ppid(pid: number): number | null
}

/** Never climb past this many ancestors: the harness is the immediate parent,
 *  so a couple of hops is plenty, and the bound guarantees the walk ends even
 *  on a pathological (cyclic) process table. */
const MAX_HOPS = 8

/** The pane id carried by OUR OWN env, using the exact precedence and the exact
 *  `??` semantics this process has always used (task 480). Unchanged on
 *  purpose: a pane that already stamps the id must resolve identically to before,
 *  so no validation is applied here -- only the walk-up fallback is picky. */
export function ownEnvPaneId(env: Record<string, string | undefined>): string | null {
  return env.HERDR_PANE_ID ?? env.VOICE_SESSION_ID ?? env.TMUX_PANE ?? null
}

/** The pane id carried by an ANCESTOR's env, accepting only plausible values so
 *  an unrelated variable can never be mistaken for a pane. HERDR_PANE_ID wins,
 *  then VOICE_SESSION_ID, then a TMUX_PANE shaped like `%<digits>`; anything
 *  else (empty, or a malformed TMUX_PANE) is ignored. */
export function ancestorEnvPaneId(env: Record<string, string>): string | null {
  const herdr = env.HERDR_PANE_ID
  if (herdr && herdr.length > 0) return herdr
  const voice = env.VOICE_SESSION_ID
  if (voice && voice.length > 0) return voice
  const tmux = env.TMUX_PANE
  if (tmux && /^%\d+$/.test(tmux)) return tmux
  return null
}

/** THE PANE ID FOR THIS SESSION. Own env first and unchanged; only when it
 *  yields nothing do we walk up from `startPpid` through the ancestry, reading
 *  each ancestor's env and taking the first pane id found. The walk is bounded
 *  (MAX_HOPS), stops at pid <= 1 (never reads init/pid 0), and returns null when
 *  nothing within the budget carries an id -- exactly the "no id" state the
 *  tools already handle. It never throws and never loops forever. */
export function resolvePaneId(
  ownEnv: Record<string, string | undefined>,
  resolver: ProcResolver,
  startPpid: number,
): string | null {
  const own = ownEnvPaneId(ownEnv)
  if (own != null) return own

  let pid = startPpid
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) break
    const env = resolver.env(pid)
    if (env) {
      const id = ancestorEnvPaneId(env)
      if (id) return id
    }
    const parent = resolver.ppid(pid)
    if (parent == null) break
    pid = parent
  }
  return null
}

/** Parse a Linux `/proc/<pid>/environ` blob (NUL-separated `KEY=VAL` records)
 *  into a plain object. Exported so a fixture can exercise the parser directly. */
export function parseProcEnviron(blob: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rec of blob.split('\0')) {
    if (!rec) continue
    const eq = rec.indexOf('=')
    if (eq <= 0) continue
    env[rec.slice(0, eq)] = rec.slice(eq + 1)
  }
  return env
}

/** Parse the KEY=VAL tokens `ps eww -o command= -p <pid>` prints after the
 *  command line (macOS). The command words come first and are not KEY=VAL, so
 *  only whitespace-separated tokens shaped like an env assignment are kept.
 *  Exported so a fixture can exercise the parser directly. */
export function parsePsEnviron(line: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const tok of line.trim().split(/\s+/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok)
    if (m) env[m[1]] = m[2]
  }
  return env
}

/** Read a pid's PPID from Linux `/proc/<pid>/stat`. The comm field is wrapped in
 *  parens and may itself contain spaces and parens, so split AFTER the last ')':
 *  the remaining fields are state, ppid, ... so ppid is the second token. */
function ppidFromProcStat(stat: string): number | null {
  const rp = stat.lastIndexOf(')')
  if (rp < 0) return null
  const rest = stat.slice(rp + 1).trim().split(/\s+/)
  const ppid = Number(rest[1])
  return Number.isInteger(ppid) ? ppid : null
}

/** The default resolver: Linux reads /proc directly; macOS shells out to ps.
 *  Every read is guarded and returns null on failure, so the walk degrades to
 *  "no id" rather than throwing on an odd host. */
export const defaultProcResolver: ProcResolver = {
  env(pid: number): Record<string, string> | null {
    if (!Number.isInteger(pid) || pid <= 1) return null
    if (process.platform === 'darwin') {
      try {
        const out = Bun.spawnSync(['ps', 'eww', '-o', 'command=', '-p', String(pid)])
        if (!out.success) return null
        return parsePsEnviron(out.stdout.toString())
      } catch {
        return null
      }
    }
    try {
      return parseProcEnviron(readFileSync(`/proc/${pid}/environ`, 'utf8'))
    } catch {
      return null
    }
  },
  ppid(pid: number): number | null {
    if (!Number.isInteger(pid) || pid <= 1) return null
    if (process.platform === 'darwin') {
      try {
        const out = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)])
        if (!out.success) return null
        const n = Number(out.stdout.toString().trim())
        return Number.isInteger(n) ? n : null
      } catch {
        return null
      }
    }
    try {
      return ppidFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    } catch {
      return null
    }
  },
}
