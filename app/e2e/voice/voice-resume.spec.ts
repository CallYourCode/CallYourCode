import {test, expect, type Page} from '@playwright/test';
import {startTransferEngine, type TransferEngine} from '../offline/transferEngine';
import {bootVoice, fieldsOf, holdMic, type Logs} from './voiceKit';

// The microphone after the app comes back from the background.
//
// The field (iPhone web app, 2026-10-03): after a background, every take had a
// flat waveform and capture.clip sttSent=0, while the recorder's clip was whole
// and its batch decode had every word. No mic.* line was logged: the context
// reported 'running' and the track live and unmuted, so the liveness model saw
// a healthy mic. Each of those takes ran on a FRESH getUserMedia stream and a
// FRESH AudioContext (the mic was released after every take), so the dead piece
// outlived any one graph; only a new page healed it. WebKit renders a page's
// AudioContexts of one format through one shared output (SharedAudioDestination),
// and the page's playback context, made at boot and never closed, held that
// output for the page's life.
//
// Neither desktop engine can produce an iOS audio-session interruption, so the
// background is reproduced by an init script with that shape: on the way back,
// the contexts the page holds sit on a dead output, and so does any context made
// while one of them is still open. A dead context reports 'running', its
// resume() resolves, and it renders nothing (natively suspended: no worklet
// frames, an analyser of zeros, a frozen clock). 'heals': the output is fresh
// once every context on it has closed (the inference above). 'never': it stays
// dead for the page's life, the case nothing on the page can fix, which must
// still record the take and say so.
//
// grep token: `mic after background`.

type Mode = 'heals' | 'never';

const BACKGROUND_FAULT = (mode: Mode) => {
  const Native = window.AudioContext;
  const nativeState = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!.get!;
  const open = new Set<AudioContext>();
  let dead: Set<AudioContext> | null = null;
  let backgrounded = false;
  let openAtHide = -1;
  const kill = (ac: AudioContext) => {
    (ac as AudioContext & {vrDead?: boolean}).vrDead = true;
    void Native.prototype.suspend.call(ac).catch(() => {});
  };
  class VrAudioContext extends Native {
    constructor(opts?: AudioContextOptions) {
      super(opts);
      open.add(this);
      if (dead || (mode === 'never' && backgrounded)) {
        dead?.add(this);
        kill(this);
      }
    }
    get state(): AudioContextState {
      const s = nativeState.call(this) as AudioContextState;
      return (this as {vrDead?: boolean}).vrDead && s !== 'closed' ? 'running' : s;
    }
    resume(): Promise<void> {
      return (this as {vrDead?: boolean}).vrDead ? Promise.resolve() : super.resume();
    }
    close(): Promise<void> {
      open.delete(this);
      if (dead) {
        dead.delete(this);
        if (!dead.size) dead = null;
      }
      return super.close();
    }
  }
  window.AudioContext = VrAudioContext;

  // Frames the app's PCM tap delivers: the graph's own output, counted outside
  // the app so the same count reads the same on any build.
  let frames = 0;
  const NativeNode = window.AudioWorkletNode;
  class VrWorkletNode extends NativeNode {
    constructor(ac: BaseAudioContext, name: string, opts?: AudioWorkletNodeOptions) {
      super(ac, name, opts);
      if (name === 'cyc-pcm-tap') this.port.addEventListener('message', () => frames++);
    }
  }
  window.AudioWorkletNode = VrWorkletNode;

  let vis: DocumentVisibilityState = 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => vis
  });
  Object.defineProperty(Document.prototype, 'hidden', {
    configurable: true,
    get: () => vis !== 'visible'
  });
  (window as unknown as {__vr: object}).__vr = {
    hide() {
      vis = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    // How many AudioContexts the page still holds when the OS takes the audio
    // session away (read just before the show).
    noteOpen() {
      openAtHide = open.size;
    },
    show() {
      backgrounded = true;
      dead = open.size ? new Set(open) : null;
      for (const ac of open) kill(ac);
      vis = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    state: () => ({open: open.size, openAtHide, dead: dead?.size ?? 0, frames})
  };
};

type VrState = {open: number; openAtHide: number; dead: number; frames: number};
const vr = (page: Page): Promise<VrState> =>
  page.evaluate(() => (window as unknown as {__vr: {state(): VrState}}).__vr.state());

type Take = {
  clip: Record<string, string>;
  mic: string[];
  litBars: number;
  bars: number;
};

const micLines = (logs: Logs, from: number) =>
  logs.lines
    .slice(from)
    .filter((l) => / app mic\.(?!disposed)/.test(l))
    .map((l) => l.replace(/^.* app /, '').replace(/ dev=\S+ pg=\S+/, ''));

// One press-and-hold take. The strip is sampled near the end of the hold; a bar
// taller than the 14% floor is audio the graph delivered.
async function take(page: Page, logs: Logs, shot: string): Promise<Take> {
  const from = logs.lines.length;
  let heights: number[] = [];
  await holdMic(page, async () => {
    await page.waitForTimeout(3_000);
    heights = await page.$$eval('.cyc-rec-level', (els) =>
      els.map((e) => parseFloat((e as HTMLElement).style.height) || 0)
    );
    const dir = process.env.VR_SHOTS;
    if (dir) await page.locator('.cyc-composer').screenshot({path: `${dir}/${shot}.png`});
  });
  await expect
    .poll(() => logs.lines.slice(from).find((l) => l.includes(' app capture.clip ')), {
      timeout: 20_000
    })
    .toBeTruthy();
  const clipLine = logs.lines.slice(from).find((l) => l.includes(' app capture.clip '))!;
  // The take settles before the next step, as on the phone.
  await expect
    .poll(() => logs.lines.slice(from).some((l) => l.includes(' app capture.verdict ')), {
      timeout: 40_000
    })
    .toBe(true);
  return {
    clip: fieldsOf(clipLine),
    mic: micLines(logs, from),
    litBars: heights.filter((h) => h > 20).length,
    bars: heights.filter((h) => h > 0).length
  };
}

async function background(page: Page, browserName: string): Promise<void> {
  await page.evaluate(() => (window as unknown as {__vr: {hide(): void}}).__vr.hide());
  if (browserName === 'chromium') {
    // A real freeze while hidden: timers stop, as on the phone. The page gets
    // a moment first to run its hide handlers (the mic release).
    await page.waitForTimeout(300);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', {state: 'frozen'});
    await page.waitForTimeout(1_200);
    await cdp.send('Page.setWebLifecycleState', {state: 'active'});
  } else {
    await page.waitForTimeout(1_500);
  }
  await page.evaluate(() => {
    const v = (window as unknown as {__vr: {noteOpen(): void; show(): void}}).__vr;
    v.noteOpen();
    v.show();
  });
  await page.waitForTimeout(500);
}

function report(browserName: string, label: string, data: unknown): void {
  console.log(`[mic after background] ${browserName} ${label}: ${JSON.stringify(data)}`);
}

async function withEngine(fn: (engine: TransferEngine) => Promise<void>): Promise<void> {
  const engine = await startTransferEngine({});
  try {
    await fn(engine);
  } finally {
    await engine.close();
  }
}

// The root cause: an AudioContext the page holds while the OS takes the audio
// session away. None may be open in the background.
test('mic after background: no AudioContext sits idle, at boot or in the background', async ({
  page,
  browserName
}) => {
  await withEngine(async (engine) => {
    const logs = await bootVoice(page, engine.port, {
      init: () => page.addInitScript(BACKGROUND_FAULT, 'heals' as Mode)
    });
    await page.waitForTimeout(1_500);
    const atBoot = await vr(page);
    await take(page, logs, `${browserName}-idle-take`);
    await background(page, browserName);
    const st = await vr(page);
    report(browserName, 'contexts', {openAtBoot: atBoot.open, openAtBackground: st.openAtHide});
    expect(atBoot.open, 'no context is open before the mic is used').toBe(0);
    expect(st.openAtHide, 'no context is open while the app is in the background').toBe(0);
  });
});

// With nothing left open, a background leaves no dead output behind: the next
// take delivers on its own (mic.foreground path=clean), no rebuild needed.
test('mic after background: the next press delivers with no fix', async ({page, browserName}) => {
  await withEngine(async (engine) => {
    const logs = await bootVoice(page, engine.port, {
      init: () => page.addInitScript(BACKGROUND_FAULT, 'heals' as Mode)
    });
    const first = await take(page, logs, `${browserName}-heals-1-before-background`);
    report(browserName, 'press take 1 (fresh page)', first);
    expect(Number(first.clip.sttSent)).toBeGreaterThan(0);
    expect(first.litBars).toBeGreaterThan(0);

    await background(page, browserName);

    const second = await take(page, logs, `${browserName}-heals-2-after-background`);
    report(browserName, 'press take 2 (after background)', second);
    expect(Number(second.clip.sttSent), 'live words get audio').toBeGreaterThan(0);
    expect(second.litBars, 'the waveform moves').toBeGreaterThan(0);
    expect(second.mic.filter((l) => l.startsWith('mic.rebuild '))).toEqual([]);
    expect(second.mic.some((l) => l.startsWith('mic.foreground path=clean by=press'))).toBe(true);
  });
});

// Hands-free keeps the mic through a background, so its own context is open
// when the OS takes the session: the graph comes back dead and the voice
// detector reads zeros. The listening check rebuilds it on the same track.
test('mic after background: hands-free rebuilds a dead graph and listens again', async ({
  page,
  browserName
}) => {
  await withEngine(async (engine) => {
    const logs = await bootVoice(page, engine.port, {
      init: () => page.addInitScript(BACKGROUND_FAULT, 'heals' as Mode)
    });
    await page.evaluate(() => (document.querySelector('.cyc-conv-toggle') as HTMLElement).click());
    await expect.poll(async () => (await vr(page)).frames, {timeout: 10_000}).toBeGreaterThan(20);

    const from = logs.lines.length;
    await background(page, browserName);
    await page.waitForTimeout(2_000);
    const a = (await vr(page)).frames;
    await page.waitForTimeout(1_500);
    const b = (await vr(page)).frames;
    const mic = micLines(logs, from);
    report(browserName, 'hands-free after background', {framesIn1500ms: b - a, mic});
    expect(b - a, 'the graph delivers again while listening').toBeGreaterThan(20);
    expect(mic.some((l) => l.startsWith('mic.rebuild '))).toBe(true);
    expect(
      mic.some((l) => l.startsWith('mic.recovered fix=rebuild') && l.includes('listening=true'))
    ).toBe(true);
    expect(
      mic.some((l) => l.startsWith('mic.foreground path=healed by=hands-free fix=rebuild'))
    ).toBe(true);
  });
});

// Nothing on the page can revive the output: one rebuild, reported, and the
// take is still recorded (its words come from the clip).
test('mic after background: an output nothing revives is reported once and the take is kept', async ({
  page,
  browserName
}) => {
  await withEngine(async (engine) => {
    const logs = await bootVoice(page, engine.port, {
      init: () => page.addInitScript(BACKGROUND_FAULT, 'never' as Mode)
    });
    const first = await take(page, logs, `${browserName}-never-1-before-background`);
    report(browserName, 'never take 1 (fresh page)', first);
    expect(Number(first.clip.sttSent)).toBeGreaterThan(0);

    await background(page, browserName);

    const second = await take(page, logs, `${browserName}-never-2-after-background`);
    report(browserName, 'never take 2 (after background)', second);
    expect(Number(second.clip.bytes), 'the recorder keeps the take').toBeGreaterThan(1200);
    expect(second.mic.filter((l) => l.startsWith('mic.rebuild ')).length).toBe(1);
    expect(second.mic.some((l) => l.startsWith('mic.recover.still-dead '))).toBe(true);
    expect(second.mic.some((l) => l.startsWith('mic.foreground path=still-dead by=press'))).toBe(
      true
    );
    expect(Number(second.clip.sttSent)).toBe(0);
    expect(second.litBars).toBe(0);
  });
});
