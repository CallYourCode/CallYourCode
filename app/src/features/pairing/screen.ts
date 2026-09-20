import {h} from '@/components/domHelpers';
import {BTN_HOVER_UTILS, makeIcon} from '@/components/iconGlyphs';
import {avatarView} from '@/components/avatarView';
import {copyText} from '@/features/media/downloads';
import {toast} from '@/components/widgets';
import {lazy} from '@/shared/lazy';
import {
  configuredEngines,
  isWsEnginePin,
  onConfiguredEngines,
  type AppEngineInfo
} from '@/engine/contract';
import {pairEngine} from '@/engine/store';
import {isTestMode} from '@/testing/testMode';
import * as keyring from '@/engine/keyring';
import {b64urldecode, importEngineKey, keyId} from '@shared/e2e';
import {bindPairRowPaint, bindPairCopyPaint, type PairRowPhase} from './pairingPaint';
import {userHostPaired} from './discovery';
const logoUrl = '/pwa/icons/favicon.svg';

type HeldKey = {kid: string; key: CryptoKey};

const PAIR_COMMAND = 'cyc pair';

const PAIRED_MS = 1300;

let heldCaptured = false;
let heldPair: string | null = null;
let heldEngine: string | null = null;
let heldApplied = false;
/* A ?pair= link followed this page load leaves the key in the URL until pairing
 * actually completes, so a refresh before the user taps Pair re-fills the key
 * instead of dead-ending on an empty box. Set when the URL carried the key,
 * cleared once the link's engine finishes pairing (stripAppliedParams there). */
let linkPairActive = false;
let linkPairEngineId: string | null = null;
const pendingByEngineId = new Map<string, HeldKey>();

function readPairParams(search: string, hash = ''): {pair: string | null; engine: string | null} {
  const q = new URLSearchParams(search);
  const h = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const pair = h.get('pair') ?? q.get('pair');
  const eng = q.get('engine') ?? h.get('engine');
  return {pair, engine: eng && !isWsEnginePin(eng) ? eng : null};
}

function capturePairParams(): void {
  if (heldCaptured) return;
  heldCaptured = true;
  const p = readPairParams(location.search, location.hash);
  heldPair = p.pair;
  heldEngine = p.engine;
  if (heldPair) {
    linkPairActive = true;
    linkPairEngineId = heldEngine;
  }
}

let requestResync: (() => void) | null = null;

/* The screen used to take the whole app over whenever ANY configured engine
 * was unpaired. That is right on first run (nothing paired, the app behind is
 * empty) and wrong once one engine works: a second machine announcing must
 * not hijack the session list. `manualOpen` marks the screen as deliberately
 * opened (an entry point tapped, or a ?pair= link followed); with at least
 * one engine paired the screen only shows when it is set, and gets a close
 * button. The mount root is remembered so an entry point can revive the
 * screen after it disposed (everything was paired when it last ran). */
let manualOpen = false;
let manualTarget: string | null = null;
let lastRoot: HTMLElement | null = null;
let lastOnActive: ((active: boolean) => void) | null = null;
let mounted: {
  disposed(): boolean;
  resync(): Promise<void>;
  focusEngine(engineId: string | null): void;
} | null = null;

/** Open the pairing screen on purpose (conversation-list banner, settings
 *  row). `engineId` scrolls/focuses that engine's key input once synced.
 *  A no-op until mountPairingScreen has run once (main.ts boot). */
export function openPairingScreen(engineId?: string): void {
  manualOpen = true;
  manualTarget = engineId ?? null;
  if ((!mounted || mounted.disposed()) && lastRoot) {
    mountPairingScreen(lastRoot, lastOnActive ?? (() => {}));
  }
  const api = mounted;
  if (!api || api.disposed()) return;
  void api.resync().then(() => {
    api.focusEngine(manualTarget);
    manualTarget = null;
  });
}

function applyScannedLink(text: string): boolean {
  let search: string;
  let hash: string;
  try {
    const u = new URL(text);
    search = u.search;
    hash = u.hash;
  } catch {
    return false;
  }
  const p = readPairParams(search, hash);
  if (!p.pair) return false;
  heldPair = p.pair;
  heldEngine = p.engine;
  heldApplied = false;
  requestResync?.();
  return true;
}

if (new URLSearchParams(location.search).get('testhooks')) {
  (window as never as {__cycPairScan: (text: string) => boolean}).__cycPairScan = (text: string) =>
    applyScannedLink(text);
}

function stripAppliedParams(): void {
  const url = new URL(location.href);
  let changed = false;
  if (url.searchParams.has('pair')) {
    url.searchParams.delete('pair');
    changed = true;
  }

  if (new URLSearchParams(url.hash.replace(/^#/, '')).has('pair')) {
    url.hash = '';
    changed = true;
  }
  const eng = url.searchParams.get('engine');
  if (eng !== null && !isWsEnginePin(eng)) {
    url.searchParams.delete('engine');
    changed = true;
  }
  if (!changed) return;
  try {
    history.replaceState(history.state, '', url.toString());
  } catch {}
}

type Row = {
  info: AppEngineInfo | null;
  engineId: string;
  userHost: string;
  url: string | null;
  el: HTMLElement;
  input: HTMLInputElement;
  pairBtn: HTMLButtonElement;
  stateEl: HTMLElement;

  done: boolean;
  phase: PairRowPhase;
  repaint: () => void;
};

type QrDecode = (video: HTMLVideoElement) => Promise<string | null>;

type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<{rawValue: string}[]>;
};

async function makeQrDecoder(): Promise<QrDecode> {
  const BD = (
    window as never as {
      BarcodeDetector?: new (o: {formats: string[]}) => BarcodeDetectorLike;
    }
  ).BarcodeDetector;
  if (BD) {
    try {
      const det = new BD({formats: ['qr_code']});
      return async (video) => {
        try {
          const found = await det.detect(video);
          return found[0]?.rawValue ?? null;
        } catch {
          return null;
        }
      };
    } catch {}
  }
  const jsQR = (await lazy(() => import('jsqr'), 'the QR scanner')).default;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  return async (video) => {
    const w = video.videoWidth,
      hh = video.videoHeight;
    if (!w || !hh || !ctx) return null;
    canvas.width = w;
    canvas.height = hh;
    ctx.drawImage(video, 0, 0, w, hh);
    const img = ctx.getImageData(0, 0, w, hh);
    return jsQR(img.data, w, hh)?.data ?? null;
  };
}

export function mountPairingScreen(
  root: HTMLElement,
  onActiveChange: (active: boolean) => void
): void {
  capturePairParams();
  lastRoot = root;
  lastOnActive = onActiveChange;

  const screen = h(
    'div',
    [
      'cyc-pairing cyc-pairing--pending hidden!',
      'absolute inset-0 z-20 flex flex-col box-border overscroll-contain',
      'bg-[var(--cyc-background-color)]',
      'pt-[var(--cyc-safe-top)] pb-[min(var(--cyc-safe-bottom),0.75rem)]'
    ].join(' ')
  );
  const scroll = h(
    'div',
    'cyc-pairing-scroll cyc-overflow flex-auto min-h-0 absolute inset-0 w-full h-full max-h-full ' +
      'overflow-hidden [-webkit-overflow-scrolling:touch]'
  );
  const card = h('div', 'cyc-pairing-card max-w-[24rem] mx-auto pt-5 px-4 pb-6 box-border');

  const head = h('div', 'cyc-pairing-head flex flex-col items-center text-center pt-3 pb-1');
  const logo = h('img', 'cyc-pairing-logo w-13 h-13 select-none', {
    src: logoUrl,
    alt: '',
    draggable: 'false'
  });
  const title = h(
    'div',
    'cyc-pairing-title select-text mt-2.5 text-[1.25rem] font-medium text-[var(--cyc-text)]'
  );
  title.textContent = 'Enter the pairing key';
  head.append(logo, title);

  const P_UTILS = 'select-text mt-2 mb-0 text-[0.9375rem] leading-[1.45]';
  const intro = h('div', 'cyc-pairing-intro pt-2 pb-3.5');
  const what = h('p', 'cyc-pairing-p ' + P_UTILS + ' text-[var(--cyc-text-muted)]');
  what.textContent =
    'Pairing gives this device the end-to-end key. ' +
    'Only your devices hold it, so no one in between can read your chats.';
  const step = h('p', 'cyc-pairing-p cyc-pairing-step ' + P_UTILS + ' text-[var(--cyc-text)]');
  step.textContent = 'Run this on the machine where your agents live:';

  const cmdBox = h(
    'div',
    [
      'cyc-pairing-cmdbox flex items-center gap-1.5 mt-2 pt-1.5 pr-1.5 pb-1.5 pl-3',
      'bg-[var(--cyc-text-muted-tint)]',
      'border border-solid border-[var(--cyc-border-color)] rounded-xl'
    ].join(' ')
  );
  const cmd = h(
    'pre',
    [
      'cyc-pairing-cmd select-text flex-auto m-0 whitespace-pre-wrap break-all',
      'font-[family-name:JetBrains_Mono,monospace]! text-[0.8125rem] leading-[1.45]',
      'text-[var(--cyc-text)]'
    ].join(' ')
  );
  cmd.textContent = PAIR_COMMAND;
  const copyBtn = h(
    'button',
    [
      'cyc-ctl cyc-pairing-copy relative flex-none flex items-center gap-[0.3125rem] overflow-hidden ' +
        BTN_HOVER_UTILS,
      'rounded-[8px] text-[var(--cyc-accent)]',
      'font-medium text-[0.8125rem]! px-2.5! py-[0.4375rem]!'
    ].join(' ')
  );
  const copyLabel = h('span', 'cyc-pairing-copy-label');
  copyLabel.textContent = 'Copy';
  copyBtn.append(makeIcon('copy', 'cyc-pairing-copy-ico text-[1rem] leading-none flex'), copyLabel);
  let copied = false;
  const repaintCopy = bindPairCopyPaint(copyBtn, () => copied);
  let copyTimer = 0;
  copyBtn.addEventListener('click', async () => {
    if (!(await copyText(PAIR_COMMAND))) {
      toast('Copy failed');
      return;
    }
    copied = true;
    copyBtn.classList.add('is-copied');
    repaintCopy();
    copyLabel.textContent = 'Copied';
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied = false;
      copyBtn.classList.remove('is-copied');
      repaintCopy();
      copyLabel.textContent = 'Copy';
    }, 1500);
  });
  cmdBox.append(cmd, copyBtn);

  const remote = h(
    'p',
    'cyc-pairing-p cyc-pairing-remote ' + P_UTILS + ' text-[var(--cyc-text-muted)]'
  );
  remote.textContent = 'If that machine is somewhere else, ssh there first.';
  const then = h('p', 'cyc-pairing-p ' + P_UTILS + ' text-[var(--cyc-text-muted)]');
  then.textContent = 'It prints your key and a QR code. Paste the key below, or scan the code.';

  const scanBtn = h(
    'button',
    [
      'cyc-ctl cyc-pairing-scan relative flex items-center justify-center gap-[0.4375rem] w-full ' +
        BTN_HOVER_UTILS,
      'mt-3.5 overflow-hidden rounded-[12px] text-[var(--cyc-accent)]',
      'font-medium text-[0.9375rem]! px-3! py-[0.6875rem]!',
      'border! border-solid! border-[var(--cyc-border-color)]!'
    ].join(' ')
  );
  scanBtn.append(
    makeIcon('qr', 'cyc-pairing-scan-ico text-[1.25rem] leading-none flex'),
    document.createTextNode('Scan QR code')
  );

  intro.append(what, step, cmdBox, remote, then, scanBtn);

  const list = h('div', 'cyc-pairing-list flex flex-col gap-3 pt-1');
  card.append(head, intro, list);
  scroll.append(card);
  screen.append(scroll);
  root.append(screen);

  let disposed = false;
  const rows: Row[] = [];
  let stopConfig = () => {};
  let stopKeyring = () => {};
  let closeScanner: (() => void) | null = null;

  const rowPaired = userHostPaired;

  const hideScreen = () => {
    manualOpen = false;
    closeScanner?.();
    screen.classList.add('hidden!');
    onActiveChange(false);
  };

  // Dismiss chrome. Present only once some engine is paired (the app behind
  // is usable then; first run keeps the takeover). Sits under the scanner
  // overlay's z-[5] so the scanner's own close wins while it is open.
  const dismissBtn = h(
    'button',
    'cyc-icon-btn cyc-pairing-close hidden! absolute! top-[calc(var(--cyc-safe-top)+0.5rem)] end-2 z-[4] ' +
      'flex items-center justify-center text-[1.5rem]! p-2! ' +
      '[transition:color_0.15s_ease-in-out,opacity_0.15s_ease-in-out] ' +
      BTN_HOVER_UTILS,
    {'aria-label': 'Close pairing'}
  );
  dismissBtn.append(makeIcon('close'));
  dismissBtn.addEventListener('click', hideScreen);
  screen.append(dismissBtn);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    manualOpen = false;
    stopConfig();
    stopKeyring();
    closeScanner?.();
    requestResync = null;
    screen.remove();
    onActiveChange(false);
  };

  const removeRow = (row: Row) => {
    row.el.remove();
    const i = rows.indexOf(row);
    if (i >= 0) rows.splice(i, 1);
    if (rows.length === 0 && pendingByEngineId.size === 0) dispose();
  };

  const finishRow = (row: Row) => {
    if (row.done) return;
    row.done = true;
    // Pairing completed. If this is the engine a ?pair= link targeted, the key
    // has served its purpose, so strip it from the URL now (not before, so a
    // mid-pair reload could recover it).
    if (linkPairActive && (linkPairEngineId === null || row.engineId === linkPairEngineId)) {
      stripAppliedParams();
      linkPairActive = false;
      linkPairEngineId = null;
    }
    row.el.classList.remove('is-confirm');
    row.el.classList.add('is-paired');
    row.phase = 'paired';
    row.repaint();
    row.stateEl.replaceChildren(
      makeIcon('check', 'cyc-pairing-check text-[1.375rem] leading-none flex text-[var(--cyc-ok)]'),
      document.createTextNode('Paired')
    );
    window.setTimeout(() => {
      if (!disposed) removeRow(row);
    }, PAIRED_MS);
  };

  const adoptPending = async (info: AppEngineInfo, pending: HeldKey) => {
    const rec = await keyring.getByUserHost(info.userHost);
    if (!rec?.key) {
      await keyring.putKey({
        userHost: info.userHost,
        kid: pending.kid,
        key: pending.key,
        label: info.userHost,
        e2e: true
      });
    }
    if (info.url) await pairEngine(info.url, info.userHost);
    pendingByEngineId.delete(info.engineId);
    const row = rows.find((r) => r.engineId === info.engineId);
    if (row) {
      row.input.disabled = false;
      row.pairBtn.disabled = false;
    }
  };

  const applyPending = async () => {
    if (pendingByEngineId.size === 0) return;
    for (const info of configuredEngines()) {
      const pending = pendingByEngineId.get(info.engineId);
      if (pending) await adoptPending(info, pending);
    }
  };

  const pairRow = async (row: Row) => {
    const raw = row.input.value.trim();
    if (!raw) {
      toast('Paste the pairing key first');
      return;
    }
    if (isTestMode()) {
      finishRow(row);
      return;
    }
    row.input.disabled = true;
    row.pairBtn.disabled = true;
    try {
      const bytes = b64urldecode(raw);
      if (bytes.length !== 32) throw new Error('the pairing key is not 32 bytes');
      const kid = await keyId(bytes);
      const key = await importEngineKey(bytes);
      if (row.info) {
        await keyring.putKey({
          userHost: row.userHost,
          kid,
          key,
          label: row.userHost,
          e2e: true
        });
        if (row.url) await pairEngine(row.url, row.userHost);

        row.stateEl.textContent = 'Pairing…';
        row.input.disabled = false;
        row.pairBtn.disabled = false;
      } else {
        pendingByEngineId.set(row.engineId, {kid, key});

        await applyPending();
        if (!pendingByEngineId.has(row.engineId)) {
          row.input.disabled = false;
          row.pairBtn.disabled = false;
        }
      }
    } catch {
      row.input.disabled = false;
      row.pairBtn.disabled = false;
      row.el.classList.remove('is-confirm');
      row.phase = 'idle';
      row.repaint();
      row.stateEl.replaceChildren();
      toast('That key does not look like a pairing key');
    }
  };

  const enterConfirm = (row: Row, key: string) => {
    row.input.value = key;
    row.el.classList.add('is-confirm');
    row.phase = 'confirm';
    row.repaint();
    row.stateEl.textContent = 'Key received';
  };

  const buildRow = (
    info: AppEngineInfo | null,
    engineId: string,
    userHost: string,
    url: string | null
  ): Row => {
    const el = h(
      'div',
      [
        'cyc-pairing-row pt-3 px-3.5 pb-3.5 rounded-[12px]',
        'bg-[var(--cyc-surface)] border border-solid border-[var(--cyc-border-color)]',
        'shadow-[0_1px_2px_rgba(0,0,0,0.08)] [transition:border-color_0.2s_ease-in-out]'
      ].join(' ')
    );

    const top = h('div', 'cyc-pairing-row-top flex items-center gap-3 min-h-12');
    const face = avatarView(
      info ? info.host : engineId,
      46,
      'cyc-pairing-row-avatar flex-none',
      undefined,
      engineId
    );
    const meta = h('div', 'cyc-pairing-row-meta flex-auto min-w-0');
    const name = h(
      'div',
      [
        'cyc-pairing-row-name select-text overflow-hidden text-ellipsis whitespace-nowrap',
        'text-[1rem] font-medium text-[var(--cyc-text)]'
      ].join(' ')
    );
    name.textContent = info ? info.host : engineId;
    const id = h(
      'div',
      [
        'cyc-pairing-row-id select-text mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis',
        'text-[0.8125rem] text-[var(--cyc-text-muted)]'
      ].join(' ')
    );

    id.textContent = info ? 'id: ' + engineId : "engine not in this build's config";
    meta.append(name, id);
    const stateEl = h(
      'div',
      [
        'cyc-pairing-row-state flex-none flex items-center gap-[0.3125rem]',
        'text-[0.875rem] font-medium text-[var(--cyc-accent)]'
      ].join(' ')
    );
    top.append(face, meta, stateEl);

    const actions = h('div', 'cyc-pairing-row-actions flex flex-col gap-2.5 mt-2');
    const field = h('div', 'cyc-field cyc-pairing-field relative flex w-full items-center');
    const input = h(
      'input',
      [
        'cyc-field-input cyc-pairing-input select-text box-border relative z-[1] w-full',
        'min-h-11 px-4 py-3 leading-[1.3] bg-[var(--cyc-surface)]',
        'rounded-xl border border-solid border-[var(--cyc-border-color)]',
        '[transition:border-color_0.15s] fine:hover:border-(--cyc-accent) fine:focus:border-(--cyc-accent)'
      ].join(' '),
      {
        type: 'text',
        placeholder: 'Paste pairing key',
        autocomplete: 'off',
        spellcheck: 'false'
      }
    );
    field.append(input);

    // explicit literals: width/text-align/overflow/position/uppercase/bold/line-height +
    // the standard-out transition, plus the `:disabled` leg (opacity/pointer-events). The
    // `cyc-ctl-primary` class stays for the shared radius machine (forced 6px); `cyc-ctl`
    // keeps its own un-layered `:disabled` backstop. Height stays the producer's `h-11!`.
    const pairBtn = h(
      'button',
      'cyc-ctl cyc-ctl-primary cyc-pairing-pair w-full text-center overflow-hidden relative ' +
        'uppercase font-medium leading-[var(--cyc-line-height)] ' +
        '[transition:opacity_0.25s_cubic-bezier(0.32,0.72,0,1),background-color_0.25s_cubic-bezier(0.32,0.72,0,1),color_0.25s_cubic-bezier(0.32,0.72,0,1)] ' +
        'disabled:pointer-events-none! disabled:opacity-[0.3] ' +
        'h-11! bg-[var(--cyc-accent)]! text-white text-[0.9375rem]!'
    );
    pairBtn.textContent = 'Pair';
    actions.append(field, pairBtn);

    el.append(top, actions);

    const row: Row = {
      info,
      engineId,
      userHost,
      url,
      el,
      input,
      pairBtn,
      stateEl,
      done: false,
      phase: 'idle',
      repaint: () => {}
    };
    row.repaint = bindPairRowPaint(el, stateEl, actions, () => row.phase);
    pairBtn.addEventListener('click', () => void pairRow(row));
    rows.push(row);
    list.append(el);
    return row;
  };

  const markApplied = () => {
    if (heldApplied) return;
    heldApplied = true;
    // Do NOT strip the URL here: the key is only pre-filled at this point, not
    // paired. Keeping it in the URL lets a reload before the Pair tap recover it.
    // stripAppliedParams runs in finishRow, once pairing actually completes.
    heldPair = null;
    heldEngine = null;
  };

  const runSync = async () => {
    if (disposed) return;

    await applyPending();
    if (disposed) return;

    const paired = await keyring.pairedUserHosts();
    if (disposed) return;

    // A followed pair link or scanned QR is a deliberate open: latch it so
    // the screen stays up through the confirm step, even after the held
    // params are consumed below.
    if (heldPair && !heldApplied) manualOpen = true;

    const engines = configuredEngines();
    const liveIds = new Set(engines.map((e) => e.engineId));

    for (const row of rows.slice()) {
      if (row.info && !liveIds.has(row.engineId)) removeRow(row);
      else if (row.info && rowPaired(row.info.userHost, row.info.url || row.url, paired))
        finishRow(row);
      else if (rowPaired(row.userHost, row.url, paired)) finishRow(row);
    }
    if (disposed) return;

    for (const info of engines) {
      if (disposed) return;
      if (rowPaired(info.userHost, info.url || null, paired)) {
        const leftover = rows.find((r) => r.engineId === info.engineId);
        if (leftover) finishRow(leftover);
        continue;
      }
      const existing = rows.find((r) => r.engineId === info.engineId);
      if (existing) {
        if (!existing.info) {
          existing.info = info;
          existing.userHost = info.userHost;
          existing.url = info.url || null;
          const nameEl = existing.el.querySelector('.cyc-pairing-row-name');
          if (nameEl) nameEl.textContent = info.host;
          const idEl = existing.el.querySelector('.cyc-pairing-row-id');
          if (idEl) idEl.textContent = info.engineId;
        }
        continue;
      }
      buildRow(info, info.engineId, info.userHost, info.url || null);
    }

    const engineId = heldEngine;
    if (!heldApplied && engineId) {
      let row = rows.find((r) => r.engineId === engineId);
      if (!row) {
        const known = engines.find((e) => e.engineId === engineId);
        if (known) {
          if (!rowPaired(known.userHost, known.url || null, paired)) {
            row = buildRow(known, known.engineId, known.userHost, known.url || null);
          }
        } else if (!paired.has(engineId)) {
          row = buildRow(null, engineId, engineId, null);
        }
      }
      if (row && heldPair && !row.done && !row.input.disabled) {
        enterConfirm(row, heldPair);
      }
      if (row || engines.some((e) => e.engineId === engineId) || paired.has(engineId)) {
        markApplied();
      }
    }

    if (rows.length === 0 && pendingByEngineId.size === 0) {
      dispose();
      return;
    }

    // First run (nothing paired) takes the screen over, as before. Once any
    // engine is paired the app behind is usable: a newly announced engine
    // surfaces as the list banner and the settings row instead, and the
    // screen shows only when deliberately opened, with a way to close it.
    const anyPaired = paired.size > 0;
    const show = !anyPaired || manualOpen;
    dismissBtn.classList.toggle('hidden!', !anyPaired);
    screen.classList.remove('cyc-pairing--pending');
    screen.classList.toggle('hidden!', !show);
    onActiveChange(show);
  };

  let tick = Promise.resolve();
  const resync = () => {
    tick = tick.then(runSync, runSync);
    return tick;
  };
  requestResync = () => {
    void resync();
  };

  const openScanner = async () => {
    if (closeScanner || disposed) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment'},
        audio: false
      });
    } catch {
      toast('Could not open the camera');
      return;
    }

    const overlay = h('div', 'cyc-pairing-scanner absolute inset-0 z-[5] bg-black');
    const video = h(
      'video',
      'cyc-pairing-scanner-video absolute inset-0 w-full h-full object-cover',
      {
        playsinline: '',
        muted: '',
        autoplay: ''
      }
    );
    video.srcObject = stream;
    const frame = h(
      'div',
      [
        'cyc-pairing-scanner-frame pointer-events-none absolute top-1/2 left-1/2',
        '-translate-x-1/2 -translate-y-1/2 w-[min(60vw,17.5rem)] aspect-square',
        'border-2 border-solid border-[rgba(255,255,255,0.85)] rounded-2xl',
        'shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]'
      ].join(' ')
    );
    const closeBtn = h(
      'button',

      // (position/ink overridden here by `absolute!`/`text-white!`).
      'cyc-icon-btn cyc-pairing-scanner-close absolute! top-[calc(var(--cyc-safe-top)+0.5rem)] end-2 z-[1] text-white! ' +
        'flex items-center justify-center text-[1.5rem]! p-2! ' +
        '[transition:color_0.15s_ease-in-out,opacity_0.15s_ease-in-out] ' +
        BTN_HOVER_UTILS,
      {
        'aria-label': 'Close camera'
      }
    );
    closeBtn.append(makeIcon('close'));
    overlay.append(video, frame, closeBtn);
    screen.append(overlay);

    let scanning = true;
    const close = () => {
      if (!scanning) return;
      scanning = false;
      window.clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      overlay.remove();
      closeScanner = null;
    };
    closeScanner = close;
    closeBtn.addEventListener('click', close);

    void video.play().catch(() => {});

    const decode = await makeQrDecoder();
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy || !scanning) return;
      busy = true;
      void decode(video).then(
        (text) => {
          busy = false;
          if (!scanning || !text) return;
          if (applyScannedLink(text)) close();
        },
        () => {
          busy = false;
        }
      );
    }, 300);
  };
  scanBtn.addEventListener('click', () => void openScanner());

  stopConfig = onConfiguredEngines(() => {
    void resync();
  });
  stopKeyring = keyring.onKeyringChange(() => {
    void resync();
  });

  mounted = {
    disposed: () => disposed,
    resync,
    focusEngine: (engineId) => {
      if (!engineId) return;
      const row = rows.find((r) => r.engineId === engineId);
      if (!row || row.done) return;
      try {
        row.el.scrollIntoView({block: 'center'});
      } catch {}
      row.input.focus();
    }
  };

  void resync();
}
