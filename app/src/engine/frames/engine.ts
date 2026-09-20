import type {ComposerWidgetDecl, EnginePluginDecl} from '../contract';
import {WIDGET_KEY_RE} from '../contract';
import {cyclog} from '@/shared/logging';
import type {FrameHandler} from './types';

const can: FrameHandler = (ctx, frame) => {
  ctx.canDo = new Set(
    Array.isArray(frame.list)
      ? frame.list.filter((x: unknown): x is string => typeof x === 'string')
      : []
  );
  cyclog('engine.can', {engine: ctx.url, can: [...ctx.canDo].join(',') || 'nothing'});
};

const plugins: FrameHandler = (ctx, frame) => {
  const raw: any[] = Array.isArray(frame.list) ? frame.list : [];
  const list: EnginePluginDecl[] = [];
  for (const p of raw) {
    if (!p || typeof p.id !== 'string' || !p.id) continue;
    if (typeof p.name !== 'string' || !p.name) continue;
    if (typeof p.version !== 'number' || !Number.isFinite(p.version)) continue;
    const decl: EnginePluginDecl = {id: p.id, name: p.name, version: p.version};
    if (p.card && typeof p.card.title === 'string' && p.card.title) {
      const floor = Number(p.card.refreshFloorS);
      decl.card = {
        title: p.card.title,
        refreshFloorS: Number.isFinite(floor) && floor >= 5 ? floor : 5
      };
    }
    if (
      p.panel &&
      typeof p.panel.icon === 'string' &&
      p.panel.icon &&
      typeof p.panel.label === 'string' &&
      p.panel.label
    ) {
      const ops = Array.isArray(p.panel.ops)
        ? p.panel.ops.filter((o: unknown): o is string => typeof o === 'string' && !!o)
        : [];

      const dock =
        p.panel.dock === 'side'
          ? ('side' as const)
          : p.panel.dock === 'page'
            ? ('page' as const)
            : ('full' as const);
      decl.panel = {
        icon: p.panel.icon,
        label: p.panel.label,
        needsSession: p.panel.needsSession === true,
        dock,
        ...(ops.length ? {ops} : {}),

        ...(typeof p.panel.badge === 'string' && p.panel.badge ? {badge: p.panel.badge} : {}),

        ...(typeof p.panel.toolbarDefault === 'boolean'
          ? {toolbarDefault: p.panel.toolbarDefault}
          : {})
      };
    }
    if (
      p.action &&
      typeof p.action.icon === 'string' &&
      p.action.icon &&
      typeof p.action.label === 'string' &&
      p.action.label
    ) {
      const rawConfirm = p.action.confirm;
      const confirm =
        rawConfirm &&
        typeof rawConfirm === 'object' &&
        typeof rawConfirm.label === 'string' &&
        rawConfirm.label.trim() &&
        typeof rawConfirm.message === 'string' &&
        rawConfirm.message.trim()
          ? {label: rawConfirm.label.trim(), message: rawConfirm.message.trim()}
          : undefined;
      decl.action = {
        icon: p.action.icon,
        label: p.action.label,
        needsSession: p.action.needsSession === true,
        ...(typeof p.action.run === 'string' && p.action.run ? {run: p.action.run} : {}),
        ...(typeof p.action.badge === 'string' && p.action.badge ? {badge: p.action.badge} : {}),
        ...(typeof p.action.toolbarDefault === 'boolean'
          ? {toolbarDefault: p.action.toolbarDefault}
          : {}),
        ...(confirm ? {confirm} : {})
      };
    }
    if (
      p.tui &&
      typeof p.tui.icon === 'string' &&
      p.tui.icon &&
      typeof p.tui.label === 'string' &&
      p.tui.label
    ) {
      decl.tui = {
        icon: p.tui.icon,
        label: p.tui.label,
        ...(typeof p.tui.toolbarDefault === 'boolean' ? {toolbarDefault: p.tui.toolbarDefault} : {})
      };
    }
    if (Array.isArray(p.composer)) {
      const widgets: ComposerWidgetDecl[] = [];
      for (const w of p.composer) {
        if (!w || typeof w.icon !== 'string' || !w.icon || typeof w.label !== 'string' || !w.label)
          continue;

        const keyOk = typeof (w as any).key === 'string' && WIDGET_KEY_RE.test((w as any).key);
        const hasKey = (w as any).key !== undefined && (w as any).key !== null;
        if (w.type === 'menu' && Array.isArray(w.items) && w.items.length) {
          if (hasKey && !keyOk) continue;
          const items = w.items
            .filter(
              (it: any) =>
                it && typeof it.text === 'string' && it.text && typeof it.insert === 'string'
            )
            .map((it: any) => ({text: it.text as string, insert: it.insert as string}));
          if (items.length)
            widgets.push({
              type: 'menu',
              icon: w.icon,
              label: w.label,
              ...(keyOk ? {key: (w as any).key as string} : {}),
              items
            });
        } else if (w.type === 'slider' && Array.isArray(w.steps) && w.steps.length) {
          if (!keyOk) continue;
          const steps = w.steps
            .filter(
              (s: any) => s && Number.isFinite(Number(s.n)) && typeof s.name === 'string' && s.name
            )
            .map((s: any) => ({
              n: Number(s.n),
              name: s.name as string,
              ...(typeof s.hint === 'string' && s.hint ? {hint: s.hint as string} : {})
            }));
          if (!steps.length) continue;

          const hasValue = (w as any).value !== undefined && (w as any).value !== null;
          const value = Number((w as any).value);
          if (hasValue && !steps.some((st: {n: number}) => st.n === value)) continue;
          widgets.push({
            type: 'slider',
            icon: w.icon,
            label: w.label,
            key: (w as any).key as string,
            ...(hasValue ? {value} : {}),
            steps
          });
        }
      }
      if (widgets.length) decl.composer = widgets;
    }
    list.push(decl);
  }
  cyclog('engine.plugins', {engine: ctx.url, ids: list.map((d) => d.id).join(',') || 'none'});
  ctx.emit('plugins', list);
};

const voice: FrameHandler = (ctx, frame) => {
  const healthy = frame.healthy !== false;
  if (healthy !== ctx.voiceHealthyState) {
    ctx.voiceHealthyState = healthy;
    cyclog('engine.voice-health', {engine: ctx.url, healthy});
    ctx.emit('voiceHealth', healthy);
  }
};

const host: FrameHandler = (ctx, frame) => {
  const u = String(frame.user ?? ''),
    h = String(frame.host ?? '');

  ctx.rememberUserHost(`${u}@${h}`);
  ctx.emit('host', u, h);
};

export const engineFrameHandlers: [string, FrameHandler][] = [
  ['can', can],
  ['plugins', plugins],
  ['voice', voice],
  ['host', host]
];
