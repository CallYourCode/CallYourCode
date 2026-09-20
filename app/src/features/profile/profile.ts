import type {CycMediaItem, CycSession} from '@/types';
import {h} from '@/components/domHelpers';
import {BTN_HOVER_UTILS, makeIcon, makeIconOrText} from '@/components/iconGlyphs';
import {avatarView, avatarSeed} from '@/components/avatarView';
import {paneHeader} from '@/features/sessions/components/paneHeader';
import {DEFAULT_AGENT_NAME} from '@/features/chat/navigation/chatRow';
import {createProfileAttachments} from './attachments';
import {toast, paintRowChrome} from '@/components/widgets';
import {contextBarIcon} from '@/features/sessions/header/contextBar';
import {copyText} from '@/features/media/downloads';
import {
  engineToolbarActions,
  toolbarActionById,
  type CycToolbarActionId
} from '@/features/settings/preferences';

export type Profile = {
  el: HTMLElement;
  update: (session: CycSession) => void;

  setPhotoBusy: (busy: boolean) => void;

  setEngineReachable: (on: boolean) => void;

  setCronCount: (n: number) => void;

  setMedia: (items: CycMediaItem[]) => void;

  retryMedia: () => void;

  refreshToolbar: () => void;
  destroy: () => void;
};

const AVATAR_PX = 120;

const ROW_UTILS =
  'relative flex min-h-14 flex-col justify-center self-stretch px-4 py-[0.4375rem] cursor-pointer overflow-hidden [transition:opacity_0.3s_cubic-bezier(0.32,0.72,0,1)]';
const TITLE_LINE_UTILS = 'order-0 flex items-center justify-between';
const SUBTITLE_LINE_UTILS = 'order-1 flex items-center justify-between';
const LINE_TITLE_UTILS =
  'relative pointer-events-none overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-auto [word-break:break-word] text-[length:1rem] leading-[var(--cyc-line-height)] text-[var(--cyc-text)]';
const SUBTITLE_SKIN =
  'text-[color:var(--cyc-text-muted)] text-[length:0.875rem] leading-[18px] mt-[0.1875rem]';
const LINE_SUBTITLE_UTILS =
  'relative pointer-events-none overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-auto ' +
  SUBTITLE_SKIN;
const PATH_SUBTITLE_UTILS =
  'relative pointer-events-none whitespace-normal overflow-visible text-clip min-w-0 flex-none [overflow-wrap:anywhere] font-[family-name:JetBrains_Mono,monospace] ' +
  SUBTITLE_SKIN;
const ROW_ICON_UTILS =
  'pointer-events-none absolute start-4 top-1/2 z-[1] [transform:translateY(-50%)] text-2xl text-[var(--cyc-text-muted)]';

export function createProfile(opts: {
  session: CycSession;
  onClose: () => void;

  onSetPhoto?: (photo: File | null) => void;

  onOpenMedia?: (item: CycMediaItem) => void;

  onNeedOlderMedia?: () => Promise<boolean>;

  onToolbarAction?: (id: CycToolbarActionId) => void;

  toolbarEngine?: (sessionId: string) => {
    engineKey: string | null;
    plugins: ReadonlySet<string>;
  };
}): Profile {
  const el = h('div', 'cyc-account flex h-full flex-col');

  const header = paneHeader('Profile', opts.onClose);

  const body = h(
    'div',
    'cyc-account-body flex min-h-0 flex-auto flex-col items-center gap-2 overflow-y-auto overflow-x-hidden px-4 py-8'
  );
  const name = h('div', 'cyc-account-name font-semibold text-[1.25rem]');
  const cwd = h(
    'div',
    'cyc-account-cwd text-center text-[var(--cyc-text-muted)] font-[family-name:JetBrains_Mono,monospace] text-[0.8125rem] leading-[1.45] [overflow-wrap:anywhere]'
  );

  let currentCwd = '';
  const pathRow = h(
    'div',
    `cyc-list-row cyc-list-row-press cyc-lit cyc-list-row-inset cyc-list-row-has-icon cyc-account-path ${BTN_HOVER_UTILS} ` +
      ROW_UTILS +
      ' flex-none'
  );
  const pathTitleRow = h('div', 'cyc-list-row-line cyc-list-row-title-line ' + TITLE_LINE_UTILS);
  const pathTitle = h('div', 'cyc-list-row-title ' + LINE_TITLE_UTILS);
  pathTitle.textContent = 'Working directory';
  pathTitleRow.append(pathTitle);
  const pathSubtitleRow = h(
    'div',
    'cyc-list-row-line cyc-list-row-subtitle-line ' + SUBTITLE_LINE_UTILS
  );
  const pathSubtitle = h('div', 'cyc-list-row-subtitle ' + PATH_SUBTITLE_UTILS);
  pathSubtitleRow.append(pathSubtitle);
  pathRow.append(
    makeIcon('copy', 'cyc-list-row-icon ' + ROW_ICON_UTILS),
    pathTitleRow,
    pathSubtitleRow
  );
  pathRow.addEventListener('click', async () => {
    if (!currentCwd) return;
    toast((await copyText(currentCwd)) ? 'Copied' : 'Copy failed');
  });

  let photoBusy = false;

  const photoPicker = h('input', '', {
    type: 'file',

    accept: 'image/*',
    hidden: 'true'
  }) as HTMLInputElement;
  photoPicker.addEventListener('change', () => {
    const f = photoPicker.files?.[0];

    photoPicker.value = '';
    if (f) opts.onSetPhoto?.(f);
  });

  const photoRow = h(
    'div',
    `cyc-list-row cyc-list-row-press cyc-lit cyc-list-row-inset cyc-list-row-has-icon ${BTN_HOVER_UTILS} ` +
      ROW_UTILS
  );
  const photoTitleRow = h('div', 'cyc-list-row-line cyc-list-row-title-line ' + TITLE_LINE_UTILS);
  const photoTitle = h('div', 'cyc-list-row-title ' + LINE_TITLE_UTILS);
  photoTitleRow.append(photoTitle);
  const photoSubtitleRow = h(
    'div',
    'cyc-list-row-line cyc-list-row-subtitle-line ' + SUBTITLE_LINE_UTILS
  );
  const photoSubtitle = h('div', 'cyc-list-row-subtitle ' + LINE_SUBTITLE_UTILS);
  photoSubtitleRow.append(photoSubtitle);
  photoRow.append(
    makeIcon('cameraAdd', 'cyc-list-row-icon ' + ROW_ICON_UTILS),
    photoTitleRow,
    photoSubtitleRow
  );
  photoRow.addEventListener('click', () => {
    if (photoBusy) return;
    photoPicker.click();
  });

  const removeRow = h(
    'div',
    `cyc-list-row cyc-list-row-press cyc-lit cyc-list-row-inset cyc-list-row-has-icon cyc-list-row-danger ${BTN_HOVER_UTILS} ` +
      ROW_UTILS +
      ' text-(--cyc-danger,#e06c62)'
  );
  const removeTitleRow = h('div', 'cyc-list-row-line cyc-list-row-title-line ' + TITLE_LINE_UTILS);
  const removeTitle = h('div', 'cyc-list-row-title ' + LINE_TITLE_UTILS);
  removeTitle.textContent = 'Remove Photo';
  removeTitleRow.append(removeTitle);
  removeRow.append(
    makeIcon('delete', 'cyc-list-row-icon ' + ROW_ICON_UTILS + ' text-(--cyc-danger,#e06c62)'),
    removeTitleRow
  );
  removeRow.addEventListener('click', () => {
    if (photoBusy) return;
    opts.onSetPhoto?.(null);
  });

  const toolbarSection = h(
    'div',
    'cyc-account-toolbar mt-5 flex flex-col gap-2 self-stretch border-t border-[var(--cyc-border-color,rgba(127,127,127,0.25))] pt-4 text-left'
  );
  const toolbarHeading = h(
    'div',
    'cyc-account-toolbar-heading mb-1 px-2 font-semibold text-[0.9375rem]'
  );
  toolbarHeading.textContent = 'Actions';
  toolbarSection.append(toolbarHeading);
  const toolbarList = h('div', 'cyc-account-toolbar-list');
  toolbarSection.append(toolbarList);
  let ctxIcon: HTMLElement | null = null;
  let cronsTitle: HTMLElement | null = null;
  let contextTitle: HTMLElement | null = null;
  let modelTitle: HTMLElement | null = null;
  let lastCronCount = 0;

  function cronsLabel(n: number): string {
    return n > 0 ? `Crons ${n}` : 'Crons';
  }

  function contextLabel(pct: number | undefined): string {
    return pct != null ? `Context ${Math.round(pct)}%` : 'Context n/a';
  }

  function modelLabel(name: string | undefined): string {
    return name ? `Model ${name}` : 'Model';
  }

  function paintContextIcon(pct: number | undefined) {
    if (!ctxIcon) return;
    const next = contextBarIcon(pct ?? 0);
    next.classList.add('cyc-list-row-icon', ...ROW_ICON_UTILS.split(' '));
    ctxIcon.replaceWith(next);
    ctxIcon = next;
  }

  let lastToolbarEngineKey: string | null = null;
  let lastToolbarPlugins: ReadonlySet<string> = new Set<string>();
  function rebuildToolbarMirror(s: CycSession) {
    toolbarList.replaceChildren();
    ctxIcon = null;
    cronsTitle = null;
    contextTitle = null;
    modelTitle = null;
    const ctx = opts.toolbarEngine?.(s.id) ?? {
      engineKey: null,
      plugins: new Set<string>()
    };
    lastToolbarEngineKey = ctx.engineKey;
    lastToolbarPlugins = ctx.plugins;
    for (const a of engineToolbarActions(ctx.engineKey, ctx.plugins)) {
      const actionRow = h(
        'div',
        `cyc-list-row cyc-list-row-press cyc-lit cyc-list-row-inset cyc-list-row-has-icon cyc-list-row-title-only ${BTN_HOVER_UTILS} ` +
          ROW_UTILS +
          // Title-only rows use important min-height so they beat the layered
          // `min-h-14` / `min-h-[2.375rem]` and `py-[0.4375rem]` they shadow.
          ' min-h-[2.375rem] min-h-[3rem]! py-[0.1875rem]!'
      );
      actionRow.dataset.cycAction = a.id;
      paintRowChrome(actionRow);
      const titleRow = h('div', 'cyc-list-row-line cyc-list-row-title-line ' + TITLE_LINE_UTILS);
      const rowTitle = h('div', 'cyc-list-row-title ' + LINE_TITLE_UTILS);
      rowTitle.textContent =
        a.id === 'crons'
          ? cronsLabel(lastCronCount)
          : a.id === 'ctx'
            ? contextLabel(s.contextPct)
            : a.id === 'model-indicator'
              ? modelLabel(s.model)
              : a.label;
      titleRow.append(rowTitle);
      if (a.id === 'crons') cronsTitle = rowTitle;
      if (a.id === 'ctx') contextTitle = rowTitle;
      if (a.id === 'model-indicator') modelTitle = rowTitle;

      const ico =
        a.id === 'ctx'
          ? contextBarIcon(s.contextPct ?? 0)
          : makeIconOrText(a.icon, 'cyc-list-row-icon ' + ROW_ICON_UTILS);
      if (a.id === 'ctx') {
        ico.classList.add('cyc-list-row-icon', ...ROW_ICON_UTILS.split(' '));
        ctxIcon = ico;
      }
      actionRow.append(ico, titleRow);
      actionRow.addEventListener('click', () => opts.onToolbarAction?.(a.id));
      toolbarList.append(actionRow);
    }
  }

  const media = createProfileAttachments({
    onOpen: (item) => opts.onOpenMedia?.(item),
    loadOlder: opts.onNeedOlderMedia ? () => opts.onNeedOlderMedia!() : undefined
  });

  body.append(name, cwd, photoRow, removeRow, pathRow, toolbarSection, media.el, photoPicker);
  // Responsive inset / press corner for the fixed profile rows (the toolbar
  // action rows register their own painter as they are rebuilt).
  for (const r of [photoRow, removeRow, pathRow]) paintRowChrome(r);
  el.append(header.el, body);

  let lastMirrorSession = '';
  let lastMirrorS: CycSession | null = null;

  function update(s: CycSession) {
    lastMirrorS = s;
    if (s.id !== lastMirrorSession) {
      lastMirrorSession = s.id;
      rebuildToolbarMirror(s);
      paintEngineRows();
    }
    body.querySelector('.cyc-account-avatar')?.remove();
    body.prepend(
      avatarView(s.name, AVATAR_PX, 'cyc-account-avatar flex-none', s.avatarUrl, avatarSeed(s))
    );
    name.textContent = s.name;

    {
      const nm = s.agentName ?? DEFAULT_AGENT_NAME;
      cwd.textContent = s.model ? `${nm} · ${s.model}` : nm;
    }

    currentCwd = s.cwd;
    pathSubtitle.textContent = s.cwd;

    const has = !!s.avatarUrl;
    photoTitle.textContent = has ? 'Change Photo' : 'Set Photo';
    removeRow.classList.toggle('cyc-off', !has);

    if (contextTitle) contextTitle.textContent = contextLabel(s.contextPct);
    if (modelTitle) modelTitle.textContent = modelLabel(s.model);
    paintContextIcon(s.contextPct);
    paintPhotoRows();
  }

  function setCronCount(n: number) {
    lastCronCount = n;
    if (cronsTitle) cronsTitle.textContent = cronsLabel(n);
  }

  function paintPhotoRows() {
    photoSubtitle.textContent = photoBusy ? 'Uploading…' : 'shown on every device';

    photoRow.classList.toggle('cyc-list-row-busy', photoBusy || !engineUp);
    removeRow.classList.toggle('cyc-list-row-busy', photoBusy || !engineUp);
  }

  function setPhotoBusy(busy: boolean) {
    photoBusy = busy;
    paintPhotoRows();
  }

  // The rows that run on the engine (the photo, and the toolbar actions that
  // need it, the context readout aside) are grey with the reason while the
  // engine cannot be reached.
  let engineUp = true;
  function paintEngineRows() {
    for (const r of toolbarSection.querySelectorAll<HTMLElement>('.cyc-list-row')) {
      const id = r.dataset.cycAction as CycToolbarActionId | undefined;
      const a = id ? toolbarActionById(lastToolbarEngineKey, id, lastToolbarPlugins) : null;
      const needs = !!a?.needsEngine && a.id !== 'ctx';
      const grey = needs && !engineUp;
      r.classList.toggle('cyc-list-row-busy', grey);
      if (grey) r.title = 'needs the engine';
      else r.removeAttribute('title');
    }
    paintPhotoRows();
  }
  function setEngineReachable(on: boolean) {
    if (engineUp === on) return;
    engineUp = on;
    paintEngineRows();
  }

  function refreshToolbar() {
    if (lastMirrorS) {
      rebuildToolbarMirror(lastMirrorS);
      paintEngineRows();
    }
  }

  update(opts.session);
  return {
    el,
    update,
    setPhotoBusy,
    setEngineReachable,
    setCronCount,
    refreshToolbar,
    setMedia: media.update,
    retryMedia: media.retryUnreachable,
    destroy: media.destroy
  };
}
