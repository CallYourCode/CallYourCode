import {expect, type Page} from '@playwright/test';
import {bootPinned} from '../offline/rig';
import {CHAT} from '../offline/transferEngine';

// Shared by the e2e/voice specs: boot a phone-sized app on a transfer engine
// with the browser's own fake microphone, open the chat, and press-and-hold the
// mic like a thumb would.

// The rig replaces getUserMedia with an oscillator on an AudioContext of its
// own. These specs need the browser's fake microphone instead (a track that no
// page AudioContext produces, as on a phone), so the native method is pinned
// before the rig's init script runs; the rig's assignment lands on the setter
// and is dropped. Each call is counted (window.__vrGum) and its tracks kept
// (window.__vrTracks), so a spec can see when the mic was asked for and
// whether a track (the phone's mic indicator) is still live.
// Pinned on the prototype: WebKit hands init scripts a mediaDevices object that
// is not the one the page uses later, so an own property would be lost.
const KEEP_NATIVE_MIC = () => {
  if (typeof MediaDevices === 'undefined') return;
  const native = MediaDevices.prototype.getUserMedia;
  const w = window as unknown as {__vrGum: number; __vrTracks: MediaStreamTrack[]};
  w.__vrGum = 0;
  w.__vrTracks = [];
  function counted(this: MediaDevices, c?: MediaStreamConstraints) {
    w.__vrGum++;
    return native.call(this, c).then((s) => {
      w.__vrTracks.push(...s.getAudioTracks());
      return s;
    });
  }
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
    configurable: true,
    get: () => counted,
    set: () => {}
  });
};

// How many times the page asked for the mic, and how many of its tracks are live.
export function micState(page: Page): Promise<{gum: number; liveTracks: number}> {
  return page.evaluate(() => {
    const w = window as unknown as {__vrGum: number; __vrTracks: MediaStreamTrack[]};
    return {gum: w.__vrGum, liveTracks: w.__vrTracks.filter((t) => t.readyState === 'live').length};
  });
}

// Playwright's WebKit (the GTK build) has no MediaRecorder, so the app's
// recorder ring cannot start there. This stand-in emits placeholder bytes on
// the same timeslice so a take completes and logs its capture.clip; the clip is
// not audio. What these specs measure (the waveform and the live stream) comes
// from the WebAudio graph, which is WebKit's own. Chromium keeps its real one.
const STAND_IN_RECORDER = () => {
  if (window.MediaRecorder) return;
  type Rec = {
    state: string;
    mimeType: string;
    ondataavailable: ((e: {data: Blob}) => void) | null;
    onstop: (() => void) | null;
    timer: number;
  };
  const emit = (r: Rec) =>
    r.ondataavailable?.({data: new Blob([new Uint8Array(4000)], {type: 'audio/webm'})});
  function StandInRecorder(this: Rec) {
    this.state = 'inactive';
    this.mimeType = 'audio/webm';
    this.ondataavailable = null;
    this.onstop = null;
    this.timer = 0;
  }
  StandInRecorder.isTypeSupported = () => false;
  StandInRecorder.prototype.start = function (this: Rec, slice = 1000) {
    this.state = 'recording';
    this.timer = window.setInterval(() => emit(this), slice);
  };
  StandInRecorder.prototype.stop = function (this: Rec) {
    if (this.state === 'inactive') return;
    clearInterval(this.timer);
    emit(this);
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 0);
  };
  (window as unknown as {MediaRecorder: unknown}).MediaRecorder = StandInRecorder;
};

export type Logs = {lines: string[]};

export async function bootVoice(
  page: Page,
  port: number,
  o: {skin?: 'day' | 'night'; init?: () => Promise<unknown>} = {}
): Promise<Logs> {
  const logs: Logs = {lines: []};
  page.on('console', (m) => {
    const t = m.text();
    if (process.env.VR_DEBUG && / app (mic|capture|ptt|release|toast|stt|boot)/.test(t)) {
      console.log(t.slice(0, 300));
    }
    if (t.includes(' app ')) logs.lines.push(t);
  });
  await page.addInitScript(KEEP_NATIVE_MIC);
  await page.addInitScript(STAND_IN_RECORDER);
  if (o.skin) {
    await page.addInitScript((skin) => localStorage.setItem('cyc-skin', skin), o.skin);
  }
  await o.init?.();
  await bootPinned(page, port, {size: {width: 390, height: 844}});
  await page.$$eval(
    '.cyc-session-entry',
    (els, chat) => {
      const row = els.find((e) => (e.textContent ?? '').includes(chat)) as HTMLElement | undefined;
      if (!row) throw new Error('no chat row for ' + chat);
      row.click();
    },
    CHAT
  );
  await page.waitForSelector('.cyc-message-list-scroll', {timeout: 10_000});
  await expect(page.locator('.cyc-composer.cyc-composer-disabled')).toHaveCount(0, {
    timeout: 15_000
  });
  return logs;
}

// Put the pointer down on the mic and keep it there until `whileHeld` is done.
export async function holdMic(page: Page, whileHeld: () => Promise<void>): Promise<void> {
  const box = await page.locator('.cyc-send-btn').boundingBox();
  if (!box) throw new Error('no mic button');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await expect(page.locator('.cyc-composer[data-cyc-recording]')).toHaveCount(1, {
      timeout: 5_000
    });
    await whileHeld();
  } finally {
    await page.mouse.up();
  }
}

// Field values of one cyclog line, `key=value` (unquoted values only).
export function fieldsOf(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/ ([A-Za-z]+)=([^\s"]+)/g)) out[m[1]] = m[2];
  return out;
}
