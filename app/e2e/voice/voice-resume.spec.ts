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
// FRESH AudioContext (the mic is released after every take), so the dead piece
// outlives any one graph; only a new page healed it. WebKit shares one platform
// output among a page's AudioContexts of the same format
// (SharedAudioDestination), and the page's playback context, made at boot and
// never closed, holds that output for the page's life.
//
// Neither desktop engine can produce an iOS audio-session interruption, so the
// background is reproduced by an init script with that shape: on the way back,
// the contexts the page holds sit on a dead output, and so does any context made
// while one of them is still open. A dead context reports 'running', its
// resume() resolves, and it renders nothing (natively suspended: no worklet
// frames, an analyser of zeros, a frozen clock). 'heals': the output is fresh
// once every context on it has closed (the inference above). 'never': it stays
// dead for the page's life, the case the rebuild cannot fix, which must still
// record the take and say so.
//
// grep token: `mic after background`.

type Mode = 'heals' | 'never';

const BACKGROUND_FAULT = (mode: Mode) => {
  const Native = window.AudioContext;
  const nativeState = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!.get!;
  const open = new Set<AudioContext>();
  let dead: Set<AudioContext> | null = null;
  let backgrounded = false;
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
    show() {
      backgrounded = true;
      dead = open.size ? new Set(open) : null;
      for (const ac of open) kill(ac);
      vis = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    contexts: () => ({open: open.size, dead: dead?.size ?? 0})
  };
};

type Take = {
  clip: Record<string, string>;
  mic: string[];
  litBars: number;
  bars: number;
};

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
  // As on the phone, the take settles and the mic is released before the next
  // step, so the next take opens a fresh stream and a fresh context.
  await expect
    .poll(() => logs.lines.slice(from).some((l) => l.includes(' app mic.disposed ')), {
      timeout: 40_000
    })
    .toBe(true);
  return {
    clip: fieldsOf(clipLine),
    mic: logs.lines
      .slice(from)
      .filter((l) => / app mic\.(?!disposed)/.test(l))
      .map((l) => l.replace(/^.* app /, '').replace(/ dev=\S+ pg=\S+/, '')),
    litBars: heights.filter((h) => h > 20).length,
    bars: heights.filter((h) => h > 0).length
  };
}

async function background(page: Page, browserName: string): Promise<void> {
  await page.evaluate(() => (window as unknown as {__vr: {hide(): void}}).__vr.hide());
  if (browserName === 'chromium') {
    // A real freeze while hidden: timers stop, as on the phone.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', {state: 'frozen'});
    await page.waitForTimeout(1_500);
    await cdp.send('Page.setWebLifecycleState', {state: 'active'});
  } else {
    await page.waitForTimeout(1_500);
  }
  await page.evaluate(() => (window as unknown as {__vr: {show(): void}}).__vr.show());
  await page.waitForTimeout(500);
}

function report(browserName: string, mode: Mode, label: string, t: Take): void {
  console.log(
    `[mic after background] ${browserName} ${mode} ${label}: ` +
      JSON.stringify({
        sttSent: Number(t.clip.sttSent),
        bytes: Number(t.clip.bytes),
        litBars: t.litBars,
        bars: t.bars,
        mic: t.mic
      })
  );
}

async function run(page: Page, browserName: string, mode: Mode) {
  const engine: TransferEngine = await startTransferEngine({});
  try {
    const logs = await bootVoice(page, engine.port, {
      init: () => page.addInitScript(BACKGROUND_FAULT, mode)
    });

    const first = await take(page, logs, `${browserName}-${mode}-1-before-background`);
    report(browserName, mode, 'take 1 (fresh page)', first);
    expect(Number(first.clip.sttSent), 'a fresh page streams its take').toBeGreaterThan(0);
    expect(first.litBars, 'a fresh page draws the take').toBeGreaterThan(0);
    expect(first.mic, 'a fresh page needs no recovery').toEqual([]);

    await background(page, browserName);

    const second = await take(page, logs, `${browserName}-${mode}-2-after-background`);
    report(browserName, mode, 'take 2 (after background)', second);
    expect(Number(second.clip.bytes), 'the recorder keeps the take').toBeGreaterThan(1200);
    expect(
      second.mic.some((l) => l.startsWith('mic.rebuild ')),
      'the stalled graph is rebuilt'
    ).toBe(true);

    if (mode === 'heals') {
      expect(
        second.mic.some((l) => l.startsWith('mic.recovered ') && l.includes('fix=rebuild'))
      ).toBe(true);
      expect(Number(second.clip.sttSent), 'live words get audio again').toBeGreaterThan(0);
      expect(second.litBars, 'the waveform moves again').toBeGreaterThan(0);

      const third = await take(page, logs, `${browserName}-${mode}-3-next-take`);
      report(browserName, mode, 'take 3 (next take)', third);
      expect(Number(third.clip.sttSent)).toBeGreaterThan(0);
      expect(third.litBars).toBeGreaterThan(0);
      expect(third.mic, 'the output stays healthy: no second rebuild').toEqual([]);
    } else {
      // Nothing on this page can revive the output: one rebuild, reported, and
      // the take is still recorded (its words come from the clip).
      expect(second.mic.filter((l) => l.startsWith('mic.rebuild ')).length).toBe(1);
      expect(second.mic.some((l) => l.startsWith('mic.recover.still-dead '))).toBe(true);
      expect(Number(second.clip.sttSent)).toBe(0);
      expect(second.litBars).toBe(0);
    }
  } finally {
    await engine.close();
  }
}

test('mic after background: a stalled graph is rebuilt and the take streams and draws', async ({
  page,
  browserName
}) => {
  await run(page, browserName, 'heals');
});

test('mic after background: an output nothing revives is reported once and the take is kept', async ({
  page,
  browserName
}) => {
  await run(page, browserName, 'never');
});
