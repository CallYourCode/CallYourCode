/* THE REPLY DIALS, FROM THE APP'S SIDE: A VIEW AND AN EDITOR, NOT AN OWNER (#585).
 *
 * The engine's reply-dials plugin owns the dial state now (its level, complexity,
 * the two on/off switches, the prompt-bits switch, the wording overrides and the
 * bit list), each engine its own. This module does two things and neither of them
 * is "hold the value":
 *
 *   1. EDIT. Every user edit is a plugin RPC to the engine that owns the chat
 *      (setReplyDial -> the `set` op). The old app-server copy is gone as a
 *      source of truth; the plugin broadcasts its redeclared composer on every
 *      change, so a slider moved on one device repaints on every other with no
 *      reload and nothing pushed on connect.
 *
 *   2. MIGRATE ONCE. On the first connect after the move, a fresh (pristine)
 *      plugin that has never been touched adopts the values the owner's old
 *      app-settings.json still holds -- his stated level, complexity, toggles and
 *      wording -- through the plugin's own `import` op. A plugin that anyone has
 *      already touched (on this or any device) is never migrated over: the
 *      pristine test read off the plugin's `get` is the once-guard, so two
 *      devices connecting at once converge on one state.
 */

import {cyclog} from '@/shared/logging';
import {globalSettings, refreshGlobalSettings, serverHasReplyDials} from '../settings';
import {RUNGS} from '../../config/replyStrings';
import {conns} from './registry';
import {pluginRpc} from './plugins';

/* An edit: move a dial on the engine that owns this chat. The plugin is the one
 * writer, so this is the ONLY path a level/complexity change takes now -- no
 * app-server write, no connect-time push. The plugin ignores the session (its
 * state is engine-global), so we pass none. */
export async function setReplyDial(engineKey: string, key: string, n: number): Promise<boolean> {
  if (key !== 'verbosity' && key !== 'complexity') return false;
  const answer = await pluginRpc(engineKey, 'reply-dials', 'set', null, {key, n});
  return answer.ok;
}

/* ---- migrate once: the old app-server dials -> the plugin ------------------ */

/* The shape of the plugin's `get`, only the fields this migration reads. */
type Defaults = {
  level: number;
  complexity: number;
  verbosityOn: boolean;
  complexityOn: boolean;
  promptBitsOn: boolean;
  names: Record<number, string>;
  texts: Record<number, string>;
  complexityNames: Record<number, string>;
  complexityTexts: Record<number, string>;
  bits: string[];
};
type EditedFlags = {edited?: {name?: boolean; text?: boolean}};
type EngineDials = {
  level: number;
  complexity: number;
  migrated: boolean;
  verbosityOn: boolean;
  complexityOn: boolean;
  promptBitsOn: boolean;
  verbosity: Record<number, EditedFlags>;
  complexity_rungs: Record<number, EditedFlags>;
  bits: string[];
  defaults: Defaults;
};

/* A plugin nobody has touched: every dial, switch and wording on its ship
 * default, and the migration flag clear. This is the once-guard -- any edit
 * (including a completed migration, which lands a non-default value) makes it
 * false, so a touched engine is never migrated over. Defaults are read off the
 * plugin's own `get`, never the app's, so the two cannot drift. */
function pristine(g: EngineDials): boolean {
  const d = g.defaults;
  if (g.migrated) return false;
  if (g.level !== d.level || g.complexity !== d.complexity) return false;
  if (g.verbosityOn !== d.verbosityOn) return false;
  if (g.complexityOn !== d.complexityOn) return false;
  if (g.promptBitsOn !== d.promptBitsOn) return false;
  for (const n of RUNGS) {
    const v = g.verbosity?.[n]?.edited;
    if (v && (v.name || v.text)) return false;
    const c = g.complexity_rungs?.[n]?.edited;
    if (c && (c.name || c.text)) return false;
  }
  if (JSON.stringify(g.bits) !== JSON.stringify(d.bits)) return false;
  return true;
}

type ImportBag = {
  strings: unknown;
  verbosityOn: boolean;
  complexityOn: boolean;
  promptBitsOn: boolean;
  level?: number;
  complexity?: number;
};

/* Build the import bag from the owner's app-server settings, or null if the app
 * server holds nothing that differs from the plugin's ship defaults (nothing to
 * migrate). A level/complexity is carried only when the SERVER actually stated it
 * (absent is a real answer, "never chose", not the fallback middle rung). */
function bagIfServerDiffers(d: Defaults): ImportBag | null {
  const g = globalSettings();
  const stated = serverHasReplyDials();
  const bag: ImportBag = {
    strings: g.strings,
    verbosityOn: g.verbosityOn,
    complexityOn: g.complexityOn,
    promptBitsOn: g.promptBitsOn
  };
  if (stated?.replyLevel) bag.level = g.replyLevel;
  if (stated?.complexity) bag.complexity = g.complexity;

  const s = g.strings ?? {};
  const rungDiffers = (
    ov: Record<number, {name?: string; text?: string}> | undefined,
    defName: Record<number, string>,
    defText: Record<number, string>
  ): boolean => {
    if (!ov) return false;
    for (const n of RUNGS) {
      const e = ov[n];
      if (!e) continue;
      if (typeof e.name === 'string' && e.name !== (defName[n] ?? '')) return true;
      if (typeof e.text === 'string' && e.text !== (defText[n] ?? '')) return true;
    }
    return false;
  };
  const differs =
    (bag.level !== undefined && bag.level !== d.level) ||
    (bag.complexity !== undefined && bag.complexity !== d.complexity) ||
    g.verbosityOn !== d.verbosityOn ||
    g.complexityOn !== d.complexityOn ||
    g.promptBitsOn !== d.promptBitsOn ||
    rungDiffers(s.reply, d.names, d.texts) ||
    rungDiffers(s.complexity, d.complexityNames, d.complexityTexts) ||
    (Array.isArray(s.bits) && JSON.stringify(s.bits) !== JSON.stringify(d.bits));

  return differs ? bag : null;
}

// Engines whose migration has been settled this app session (migrated, or found
// already touched, or nothing to migrate): never asked again while the tab lives.
const settled = new Set<string>();
const inflight = new Map<string, Promise<void>>();

async function migrateOne(engineKey: string): Promise<void> {
  if (settled.has(engineKey) || inflight.has(engineKey)) return;
  const run = (async () => {
    try {
      // the app-server copy is the migration SOURCE; read it before deciding
      await refreshGlobalSettings();

      const answer = await pluginRpc(engineKey, 'reply-dials', 'get', null, {});
      if (!answer.ok || !answer.result || typeof answer.result !== 'object') return; // retry next edge
      const g = answer.result as EngineDials;
      if (!g.defaults) return; // an engine too old to report defaults: leave it be, retry

      if (!pristine(g)) {
        settled.add(engineKey);
        return; // already someone's, on this or another device: never migrate over
      }
      const bag = bagIfServerDiffers(g.defaults);
      if (!bag) {
        settled.add(engineKey);
        return; // the app server holds only defaults: nothing to move
      }
      const done = await pluginRpc(engineKey, 'reply-dials', 'import', null, bag);
      if (done.ok) {
        settled.add(engineKey);
        cyclog('dials.migrated', {level: bag.level ?? null, complexity: bag.complexity ?? null});
      }
    } catch {
      // an unreachable engine or a refused rpc: leave the engine unsettled so the
      // next connect edge tries again, and never surface as an unhandled reject
    }
  })().finally(() => inflight.delete(engineKey));
  inflight.set(engineKey, run);
  await run.catch(() => {});
}

/* Called on the connected/settled edge. With an engineKey, migrate that engine;
 * without, sweep every connected engine (the boot case). */
export function syncReplyDials(engineKey?: string): void {
  const keys = engineKey ? [engineKey] : conns.map((c) => c.key);
  for (const k of keys) void migrateOne(k);
}
