import {h} from '../components/domHelpers';
import {paneHeader} from '../features/sessions/components/paneHeader';
import {cyclog} from '@/shared/logging';
import {
  PAGE_SANDBOX,
  frameDocument,
  themeVars,
  installSandboxBridge,
  loadSandboxDocument
} from '@/features/plugins/sandbox';
import * as engine from '../engine/store';
import {loadErrorText} from '../features/media/loadError';
import type {EnginePluginDecl} from '../engine/contract';

let openPanel: (() => void) | null = null;

export function openPluginPanel(o: {
  engineKey: string;
  plugin: EnginePluginDecl;
  sessionId: string | null;

  onGoto?: (ref: {
    seq?: number;
    ts: number;
    role: 'user' | 'claude';
  }) => Promise<{ok: boolean; message?: string}>;
}) {
  openPanel?.();
  const {engineKey, plugin} = o;
  const panel = plugin.panel;
  if (!panel) return;
  const allowedOps = new Set(panel.ops ?? []);

  const session = panel.needsSession ? o.sessionId : null;

  const dock = plugin.id === 'crons' ? 'side' : (panel.dock ?? 'full');
  const side = dock === 'side';

  const page = dock === 'page';

  const overlay = h(
    'div',
    'cyc-plugin-panel absolute inset-0 z-[11] flex flex-col bg-[var(--cyc-surface)]'
  );
  if (side) overlay.classList.add('is-side');
  if (page) overlay.classList.add('is-page');
  const stage = h('div', 'cyc-plugin-panel-stage flex flex-1 min-h-0');
  if (page) {
    overlay.append(stage);
  } else {
    const headerTitle = plugin.id === 'crons' ? 'Scheduled and recurring messages' : plugin.name;
    overlay.append(paneHeader(headerTitle, () => close()).el, stage);
  }

  const teardown = () => {
    bridge.uninstall();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('pointerdown', onOutside, true);

    const frame = stage.querySelector('iframe');
    if (frame) frame.src = 'about:blank';
  };

  const close = () => {
    if (openPanel !== close) return;
    openPanel = null;
    teardown();
    if (!side) {
      overlay.remove();
      return;
    }

    overlay.classList.remove('is-open');
    let removed = false;
    const done = () => {
      if (removed) return;
      removed = true;
      overlay.removeEventListener('transitionend', onEnd);
      overlay.remove();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === overlay && e.propertyName === 'transform') done();
    };
    overlay.addEventListener('transitionend', onEnd);
    window.setTimeout(done, 320);
  };
  openPanel = close;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const onPop = () => close();

  const onOutside = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (!t || overlay.contains(t) || t.closest('.cyc-mast') || t.closest('.cyc-modal')) return;
    close();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);
  if (side) document.addEventListener('pointerdown', onOutside, true);

  const bridge = installSandboxBridge(() => stage.querySelector('iframe'), {
    onClose: close,
    onCall: async (op, args) => {
      if (!allowedOps.has(op)) {
        cyclog('plugin.call.refused', {plugin: plugin.id, op});
        return {
          ok: false,
          message: `this panel did not declare the op "${op}", so nothing was called`
        };
      }
      return engine.pluginRpc(engineKey, plugin.id, op, session, args);
    },
    onSave: (state) => engine.pluginStateSave(engineKey, plugin.id, session, state),
    onLoad: () => engine.pluginStateLoad(engineKey, plugin.id, session),

    onGoto: o.onGoto
      ? async (ref) => {
          const r = await o.onGoto!(ref);
          if (r.ok && !side) close();
          return r;
        }
      : undefined
  });

  const fail = (message: string) => {
    const errEl = h('div', 'cyc-plugin-panel-error p-4 text-[var(--cyc-text-muted)]');
    errEl.textContent = message;
    stage.append(errEl);
  };

  // Build (or rebuild) the sandbox iframe from panel HTML. The cache layer may
  // call this twice on the no-version revalidate path, so it clears the stage
  // and mounts a fresh frame each time; the only change from the pre-cache flow
  // is where `html` comes from.
  const renderStage = (html: string) => {
    if (openPanel !== close) return;
    const prev = stage.querySelector('iframe');
    if (prev) prev.src = 'about:blank';
    stage.textContent = '';

    const {theme, vars} = themeVars('panel');

    if (page) {
      const q = new URLSearchParams(location.search);
      if (q.get('testhooks')) {
        const knob = Number(plugin.id === 'files' ? q.get('fsReadMs') : q.get('gitReadMs'));
        if (Number.isFinite(knob) && knob > 0) vars['--cyc-read-ms'] = String(knob);
      }
    }
    const frame = document.createElement('iframe');
    frame.className = 'cyc-plugin-panel-frame flex-1 w-full border-0 bg-[var(--cyc-surface)]';
    frame.setAttribute('sandbox', PAGE_SANDBOX);

    frame.setAttribute('allow', page ? 'clipboard-write' : '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = plugin.name;

    stage.append(frame);
    loadSandboxDocument(frame, frameDocument(html, theme, vars));

    if (page) requestAnimationFrame(() => frame.focus());
  };

  void (async () => {
    try {
      await engine.pluginPanelHtmlCached(engineKey, plugin.id, plugin.version, renderStage);
    } catch (err) {
      if (openPanel !== close) return;
      fail(loadErrorText(plugin.name, err));
    }
  })();

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);

  if (side) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (openPanel === close) overlay.classList.add('is-open');
      })
    );
  }
}

export function openPluginPanelById(
  pluginId: string,
  sessionId: string | null,
  onGoto?: (ref: {
    seq?: number;
    ts: number;
    role: 'user' | 'claude';
  }) => Promise<{ok: boolean; message?: string}>
): boolean {
  const found = engine.findPanelPlugin(pluginId);
  if (!found) return false;
  openPluginPanel({engineKey: found.engineKey, plugin: found.plugin, sessionId, onGoto});
  return true;
}
