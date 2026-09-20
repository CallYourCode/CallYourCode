/* THE PANE-ID RECOVERY (paneid.ts). Proves the walk-up that lets a codex-spawned
 * MCP -- launched with a scrubbed env while the harness above it still carries
 * the pane -- find its id, WITHOUT any real process: a fake resolver maps a pid
 * to a fixed {ppid, env}.
 *
 *   bun test mcp/src/paneid.test.ts
 */

import { test, expect } from 'bun:test'
import {
  resolvePaneId,
  ownEnvPaneId,
  ancestorEnvPaneId,
  parseProcEnviron,
  parsePsEnviron,
  type ProcResolver,
} from './paneid.ts'

/** A resolver over an in-memory pid table. `consulted` records every pid whose
 *  env was read, so a test can assert the fallback was NEVER touched. */
function fakeResolver(
  table: Record<number, { ppid: number; env: Record<string, string> }>,
): ProcResolver & { consulted: number[] } {
  const consulted: number[] = []
  return {
    consulted,
    env(pid) {
      consulted.push(pid)
      return table[pid]?.env ?? null
    },
    ppid(pid) {
      return table[pid]?.ppid ?? null
    },
  }
}

// The MCP's own pid is irrelevant; the walk starts at its PARENT (process.ppid).
// Use pid 1000 as "our parent" throughout, climbing 1000 -> 900 -> 800.

test('own env with TMUX_PANE is used directly, the resolver is never consulted', () => {
  const r = fakeResolver({ 1000: { ppid: 900, env: { TMUX_PANE: '%111' } } })
  expect(resolvePaneId({ TMUX_PANE: '%742' }, r, 1000)).toBe('%742')
  expect(r.consulted).toEqual([]) // no walk happened
})

test('own env empty, PARENT env has TMUX_PANE=%742 -> recovered', () => {
  const r = fakeResolver({ 1000: { ppid: 900, env: { TMUX_PANE: '%742' } } })
  expect(resolvePaneId({}, r, 1000)).toBe('%742')
})

test('own env empty, parent empty, GRANDPARENT has HERDR_PANE_ID -> recovered', () => {
  const r = fakeResolver({
    1000: { ppid: 900, env: {} },
    900: { ppid: 800, env: { HERDR_PANE_ID: 'pane-abc' } },
  })
  expect(resolvePaneId({}, r, 1000)).toBe('pane-abc')
})

test('HERDR_PANE_ID takes precedence over TMUX_PANE on the same ancestor', () => {
  const r = fakeResolver({
    1000: { ppid: 900, env: { HERDR_PANE_ID: 'pane-h', TMUX_PANE: '%742' } },
  })
  expect(resolvePaneId({}, r, 1000)).toBe('pane-h')
})

test('nothing within the hop budget -> null, no throw, no hang', () => {
  // A long chain that never carries an id. The bound must stop the walk.
  const table: Record<number, { ppid: number; env: Record<string, string> }> = {}
  for (let pid = 1000; pid >= 100; pid -= 100) table[pid] = { ppid: pid - 100, env: {} }
  const r = fakeResolver(table)
  expect(resolvePaneId({}, r, 1000)).toBeNull()
  expect(r.consulted.length).toBeLessThanOrEqual(8) // MAX_HOPS
})

test('a malformed TMUX_PANE on an ancestor is NOT accepted', () => {
  const r = fakeResolver({ 1000: { ppid: 900, env: { TMUX_PANE: 'garbage' } } })
  expect(resolvePaneId({}, r, 1000)).toBeNull()
})

test('the walk stops at pid <= 1 and never reads init/pid 0', () => {
  const r = fakeResolver({ 1000: { ppid: 1, env: {} } })
  expect(resolvePaneId({}, r, 1000)).toBeNull()
  expect(r.consulted).toEqual([1000]) // pid 1 was never read
})

test('a resolver that returns null for a pid does not stop a valid grandparent', () => {
  const r: ProcResolver = {
    env: (pid) => (pid === 800 ? { HERDR_PANE_ID: 'deep' } : null),
    ppid: (pid) => (pid === 1000 ? 900 : pid === 900 ? 800 : null),
  }
  expect(resolvePaneId({}, r, 1000)).toBe('deep')
})

// ---- the picker precedence, in isolation ----

test('ownEnvPaneId keeps the exact ?? precedence (empty string is kept, not skipped)', () => {
  expect(ownEnvPaneId({ HERDR_PANE_ID: 'h', TMUX_PANE: '%1' })).toBe('h')
  expect(ownEnvPaneId({ VOICE_SESSION_ID: 'v', TMUX_PANE: '%1' })).toBe('v')
  expect(ownEnvPaneId({ TMUX_PANE: '%1' })).toBe('%1')
  expect(ownEnvPaneId({})).toBeNull()
  // ?? only falls through on null/undefined, so an empty HERDR wins (unchanged).
  expect(ownEnvPaneId({ HERDR_PANE_ID: '', TMUX_PANE: '%1' })).toBe('')
})

test('ancestorEnvPaneId validates: precedence, empties ignored, TMUX shape enforced', () => {
  expect(ancestorEnvPaneId({ HERDR_PANE_ID: 'h', VOICE_SESSION_ID: 'v', TMUX_PANE: '%1' })).toBe('h')
  expect(ancestorEnvPaneId({ VOICE_SESSION_ID: 'v', TMUX_PANE: '%1' })).toBe('v')
  expect(ancestorEnvPaneId({ TMUX_PANE: '%742' })).toBe('%742')
  expect(ancestorEnvPaneId({ HERDR_PANE_ID: '', TMUX_PANE: '%1' })).toBe('%1') // empty herdr skipped
  expect(ancestorEnvPaneId({ TMUX_PANE: 'garbage' })).toBeNull()
  expect(ancestorEnvPaneId({ TMUX_PANE: '%' })).toBeNull()
  expect(ancestorEnvPaneId({})).toBeNull()
})

// ---- the env parsers, via fixtures ----

test('parseProcEnviron splits NUL-separated KEY=VAL records', () => {
  const blob = 'TMUX_PANE=%742\0HERDR_PANE_ID=pane-x\0PATH=/usr/bin\0'
  expect(parseProcEnviron(blob)).toEqual({
    TMUX_PANE: '%742',
    HERDR_PANE_ID: 'pane-x',
    PATH: '/usr/bin',
  })
})

test('parseProcEnviron keeps `=` in values and ignores malformed records', () => {
  const blob = 'FOO=a=b=c\0\0=leading\0BARE\0'
  expect(parseProcEnviron(blob)).toEqual({ FOO: 'a=b=c' })
})

test('parsePsEnviron keeps only KEY=VAL tokens after the command words', () => {
  const line = '/usr/bin/codex mcp --stdio TERM=xterm TMUX_PANE=%742 HERDR_PANE_ID=pane-y'
  expect(parsePsEnviron(line)).toEqual({
    TERM: 'xterm',
    TMUX_PANE: '%742',
    HERDR_PANE_ID: 'pane-y',
  })
})
