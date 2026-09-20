import type {EnginePluginDecl} from '../contract';
import {connOf, conns, paneIdOf} from './registry';
import {engineFetch} from './engineFetch';
import * as panelVault from '../panelVault';

type PluginsDeps = {
  liveEngineKeys(): Set<string>;
};
let deps: PluginsDeps | null = null;
export function wirePlugins(d: PluginsDeps): void {
  deps = d;
}

export function pluginsOf(engineKey: string): EnginePluginDecl[] {
  return connOf(engineKey)?.plugins ?? [];
}

export function toolbarPluginIds(engineKey: string): Set<string> {
  const out = new Set<string>();
  for (const p of connOf(engineKey)?.plugins ?? []) {
    if (p.panel || p.action || p.tui) out.add(p.id);
  }
  return out;
}

export function sessionScopedToolbarPluginIds(engineKey: string): Set<string> {
  const out = new Set<string>();
  for (const p of connOf(engineKey)?.plugins ?? []) {
    if (p.panel?.needsSession || p.action?.needsSession) out.add(p.id);
  }
  return out;
}

export function declaredToolbarDefaults(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of conns) {
    for (const p of c.plugins) {
      const d = p.panel?.toolbarDefault ?? p.action?.toolbarDefault ?? p.tui?.toolbarDefault;
      if (typeof d === 'boolean') out[p.id] = out[p.id] === true ? true : d;
    }
  }
  return out;
}

export function cardEngines(pluginId: string): {engineKey: string}[] {
  const live = deps?.liveEngineKeys() ?? new Set<string>();
  return conns
    .filter((c) => live.has(c.key) && c.plugins.some((p) => p.id === pluginId && p.card))
    .map((c) => ({engineKey: c.key}));
}

export async function pluginCardOf(
  engineKey: string,
  pluginId: string,
  refresh = false
): Promise<{
  ok: boolean;
  html?: string;
  ageMs?: number | null;
  height?: number;
  dedupe?: string;
  stale?: boolean;
  throttled?: boolean;
  error?: string;
}> {
  try {
    const res = await engineFetch(
      engineKey,
      '/plugin/' + encodeURIComponent(pluginId) + '/card' + (refresh ? '?refresh=1' : ''),
      {timeoutMs: refresh ? 12000 : 8000}
    );
    const body = (await res.json().catch((): null => null)) as {
      ok?: boolean;
      html?: string;
      ageMs?: number | null;
      height?: number;
      dedupe?: string;
      stale?: boolean;
      throttled?: boolean;
      error?: string;
    } | null;
    if (res.ok && body?.ok) {
      const html = typeof body.html === 'string' ? body.html : '';
      if (!html) return {ok: false, error: 'empty card'};

      const ageMs = typeof body.ageMs === 'number' ? body.ageMs : null;
      const dedupe = typeof body.dedupe === 'string' ? body.dedupe : null;
      return {
        ok: true,
        html,
        ageMs,
        ...(typeof body.height === 'number' ? {height: body.height} : {}),
        ...(dedupe ? {dedupe} : {}),
        ...(typeof body.stale === 'boolean' ? {stale: body.stale} : {}),
        ...(typeof body.throttled === 'boolean' ? {throttled: body.throttled} : {})
      };
    }
    return {ok: false, error: body?.error ?? `http ${res.status}`};
  } catch (e) {
    return {
      ok: false,
      error: (e as Error)?.name === 'TimeoutError' ? 'timed out' : 'engine unreachable'
    };
  }
}

export function findPanelPlugin(
  pluginId: string
): {engineKey: string; plugin: EnginePluginDecl} | null {
  for (const c of conns) {
    const plugin = c.plugins.find((p) => p.id === pluginId && p.panel);
    if (plugin) return {engineKey: c.key, plugin};
  }
  return null;
}

export async function pluginPanelHtml(engineKey: string, id: string): Promise<string> {
  const c = connOf(engineKey);
  if (!c) throw new Error('no such engine');
  return c.client.pluginPanelHtml(id);
}

// Cache-backed panel load: renders version-matched bytes from memory or
// IndexedDB with no fetch, and only reaches the engine on a miss, a version
// mismatch, or a no-version revalidate. `render` sources the sandbox `html`;
// it may be called twice on the no-version path, so it must clear and rebuild
// the stage each time.
export function pluginPanelHtmlCached(
  engineKey: string,
  id: string,
  version: number,
  render: (html: string) => void
): Promise<void> {
  return panelVault.loadPanel(engineKey, id, version, () => pluginPanelHtml(engineKey, id), render);
}

export async function pluginRpc(
  engineKey: string,
  id: string,
  op: string,
  session: string | null,
  args: unknown
): Promise<{ok: boolean; result?: unknown; message?: string}> {
  const c = connOf(engineKey);
  if (!c) return {ok: false, message: 'no such engine'};
  return c.client.pluginRpc(id, op, paneIdOf(session), args);
}

export async function pluginStateLoad(
  engineKey: string,
  id: string,
  session: string | null
): Promise<{ok: boolean; saved: boolean; data: unknown; message: string}> {
  const c = connOf(engineKey);
  if (!c) return {ok: false, saved: false, data: null, message: 'no such engine'};
  return c.client.pluginStateLoad(id, paneIdOf(session));
}
export async function pluginStateSave(
  engineKey: string,
  id: string,
  session: string | null,
  body: string
): Promise<{ok: boolean; message: string}> {
  const c = connOf(engineKey);
  if (!c) return {ok: false, message: 'no such engine'};
  return c.client.pluginStateSave(id, paneIdOf(session), body);
}
