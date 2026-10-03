import {test, expect, type Page} from '@playwright/test';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {bootPinned} from './rig';
import {startChatEngine, type ChatEngine} from './chatEngine';
import {openChat, waitLive} from './offlineKit';

// PLAY-TAP (2026-10-03, BZ Distributor, iPhone): "I had to click the play
// button so many times". The field sequence, through the app's real code: a
// voice note was sent and its capture is still awaiting its transcript
// (pipeline.fire took the speaker's busy claim; it holds until the verdict,
// 20-24 s in the field); he opens the chat and presses play; the verdict lands
// (commitUtterance, kept) and the capture releases. Plus the slow-tunnel cases:
// a reply that fits one tunnel frame, one that spans several, and repeated
// presses while loading. Real reply clips only (copied engine data), each
// sealed frame of an /audio reply delayed by PLAYTAP_FRAME_MS.
//
// Runs under play-tap.config.ts (Chromium desktop, WebKit iPhone). The WebKit
// pass deletes window.MediaSource, as an iPhone has none (it has only
// ManagedMediaSource). PLAYTAP_TAG names the result file (before/after) and,
// when "before", records without asserting.
//
// grep token: `play tap`.

const DIR = process.env.PLAYTAP_AUDIO_DIR;
const TAG = process.env.PLAYTAP_TAG === 'before' ? 'before' : 'after';
const OUT = process.env.PLAYTAP_OUT;
const FRAME_MS = Number(process.env.PLAYTAP_FRAME_MS ?? 1200);

test.skip(
  !DIR,
  'set PLAYTAP_AUDIO_DIR to a directory of copied engine reply clips; this spec synthesises no audio'
);

const CHAT = 'bzdist';
// The field clip (168 KB, one tunnel frame) and a long reply (850 KB, four).
const SHORT = '446cc5b1-cc3a-4285-8441-03dc8d8433f7';
const LONG = 'f6ff14d6-d5bd-4fe8-b7ae-87017d1d5a96';
// A spoken reply is a voice card; its play button is the card's toggle.
const playButton = (msgId: string) => `.cyc-clip.cyc-voice[data-msg-id="${msgId}"] .cyc-clip-toggle`;

type Rec = {
  clicks: number[];
  states: {t: number; state: string; msg?: string}[];
  pendingAt: number | null;
  logs: {t: number; event: string; fields: Record<string, unknown>}[];
  // every object URL the page minted: a MediaSource (streamed) or a Blob's size
  urls: {t: number; kind: string}[];
};

async function startBz(fetches: string[]): Promise<ChatEngine> {
  const now = Date.now();
  const clip = (id: string) => readFileSync(resolve(DIR!, `${id}.mp3`));
  return startChatEngine({
    sessions: [
      {
        id: CHAT,
        name: 'BZ Distributor',
        messages: [
          {seq: 0, role: 'user', text: 'check the distributor list', ts: now - 60_000, msgId: 'u0'},
          {seq: 1, role: 'claude', text: 'A long reply about the list.', ts: now - 50_000, msgId: LONG},
          {seq: 2, role: 'user', text: 'and the website issues?', ts: now - 40_000, msgId: 'u1'},
          {seq: 3, role: 'claude', text: 'The SE Ranking report shows a few things.', ts: now - 30_000, msgId: SHORT}
        ]
      }
    ],
    route: (req) => {
      const m = req.path.match(/^\/audio\/([^/?]+)\.mp3/);
      if (!m) return undefined;
      fetches.push(m[1]);
      const bytes = new Uint8Array(clip(m[1]));
      return {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': String(bytes.byteLength),
          'access-control-allow-origin': '*'
        },
        body: bytes,
        frameDelayMs: FRAME_MS
      };
    }
  });
}

async function boot(page: Page, port: number, browserName: string) {
  if (browserName === 'webkit') {
    await page.addInitScript(() => {
      delete (window as unknown as {MediaSource?: unknown}).MediaSource;
    });
  }
  // The recorder: every press on a play button, every speaker state change,
  // when the button first shows its spinner, and the app's clip.* log lines.
  await page.addInitScript(() => {
    const rec: Rec = {clicks: [], states: [], pendingAt: null, logs: [], urls: []};
    (window as unknown as {__tapRec: Rec}).__tapRec = rec;
    const mint = URL.createObjectURL;
    URL.createObjectURL = (o: Blob | MediaSource) => {
      rec.urls.push({
        t: performance.now(),
        kind: o instanceof Blob ? `blob:${o.size}` : (o?.constructor?.name ?? 'other')
      });
      return mint.call(URL, o);
    };
    (window as unknown as {__cycLogTap: unknown}).__cycLogTap = (
      event: string,
      fields: Record<string, unknown>
    ) => {
      if (event.startsWith('clip.')) rec.logs.push({t: performance.now(), event, fields});
    };
    document.addEventListener(
      'click',
      (e) => {
        if ((e.target as Element | null)?.closest?.('.cyc-clip-toggle')) rec.clicks.push(performance.now());
      },
      true
    );
    let last = '';
    setInterval(() => {
      const get = (window as unknown as {__cycSpeakerState?: () => {state: string; msgId?: string}})
        .__cycSpeakerState;
      if (!get) return;
      const st = get();
      const key = `${st.state}|${st.msgId ?? ''}`;
      if (key !== last) {
        last = key;
        rec.states.push({t: performance.now(), state: st.state, msg: st.msgId});
      }
      if (rec.pendingAt === null && document.querySelector('.cyc-clip-toggle.cyc-pending'))
        rec.pendingAt = performance.now();
    }, 10);
  });
  await bootPinned(page, port, {size: {width: 390, height: 844}});
  await openChat(page, 'BZ Distributor');
  await waitLive(page);
  await page.waitForSelector(playButton(SHORT));
}

async function press(page: Page, msgId: string, browserName: string) {
  const btn = page.locator(playButton(msgId));
  if (browserName === 'webkit') await btn.tap();
  else await btn.click();
}

const rec = (page: Page) => page.evaluate(() => (window as unknown as {__tapRec: Rec}).__tapRec);
const now = (page: Page) => page.evaluate(() => performance.now());
const speaking = async (page: Page, msgId: string) =>
  page.evaluate(
    (id) => {
      const st = (window as unknown as {__cycSpeakerState: () => {state: string; msgId?: string}})
        .__cycSpeakerState();
      return st.state === 'speaking' && st.msgId === id;
    },
    msgId
  );

function firstSpeaking(r: Rec, msgId: string, after: number): number | null {
  return r.states.find((s) => s.t >= after && s.state === 'speaking' && s.msg === msgId)?.t ?? null;
}

const results: Record<string, unknown> = {};
function record(name: string, browserName: string, data: Record<string, unknown>) {
  results[`${browserName}:${name}`] = data;
  if (!OUT) return;
  mkdirSync(OUT, {recursive: true});
  const file = resolve(OUT, `play-tap-${TAG}-${browserName}.json`);
  let prior: Record<string, unknown> = {};
  try {
    prior = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  writeFileSync(file, JSON.stringify({...prior, [name]: data}, null, 2));
}

test('play tap: a press while a capture awaits its transcript (the field case)', async ({
  page,
  browserName
}) => {
  test.setTimeout(90_000);
  const fetches: string[] = [];
  const engine = await startBz(fetches);
  try {
    await boot(page, engine.port, browserName);
    // pipeline.fire, then the press is released: the capture is in flight,
    // holding the speaker until its verdict.
    await page.evaluate(() => {
      const p = (window as unknown as {__cycPipeline: Record<string, unknown> & {fire(): void}})
        .__cycPipeline;
      p.fire();
      (p as {active: unknown}).active = null;
    });
    const t0 = await now(page);
    // He presses once a second while the press shows him nothing (no spinner,
    // no sound), the way the field log reads, until the transcript lands (6 s
    // here; 20-24 s in the field). A press that shows nothing within 300 ms is
    // a swallowed press.
    const visible = () =>
      page.evaluate((sel) => !!document.querySelector(sel), `${playButton(SHORT)}.cyc-pending`);
    let presses = 0;
    let swallowed = 0;
    const VERDICT_AT = 6_000;
    while ((await now(page)) - t0 < VERDICT_AT && !(await speaking(page, SHORT))) {
      if (!(await visible())) {
        await press(page, SHORT, browserName);
        presses++;
        await page.waitForTimeout(300);
        if (!(await visible()) && !(await speaking(page, SHORT))) swallowed++;
      }
      await page.waitForTimeout(700);
    }
    const heardBeforeVerdict = await speaking(page, SHORT);
    // The verdict lands: the utterance is kept (commitUtterance), the capture
    // releases.
    await page.evaluate(async () => {
      const p = (window as unknown as {
        __cycPipeline: {
          inFlight: Map<number, {id: number}>;
          commitUtterance(c: unknown, r: unknown, h: unknown, b: () => Promise<null>): Promise<void>;
        };
      }).__cycPipeline;
      const cap = [...p.inFlight.values()].pop()!;
      await p.commitUtterance(
        cap,
        {id: cap.id, forCapture: undefined, durationS: 99},
        {text: '', streamed: true, failed: false, decoded: true, blob: null},
        async () => null
      );
    });
    // After the verdict he presses again until it sounds (cap 6 more).
    let after = 0;
    while (!(await speaking(page, SHORT)) && after < 6) {
      await page.waitForTimeout(FRAME_MS + 800);
      if (await speaking(page, SHORT)) break;
      if (await visible()) continue;
      await press(page, SHORT, browserName);
      after++;
    }
    await page.waitForTimeout(FRAME_MS + 800);
    const r = await rec(page);
    const sound = firstSpeaking(r, SHORT, t0);
    const data = {
      frameMs: FRAME_MS,
      presses: presses + after,
      pressesBeforeVerdict: presses,
      swallowedBeforeVerdict: swallowed,
      heardBeforeVerdict,
      sounded: sound !== null,
      firstPressToSoundMs: sound === null || !r.clicks.length ? null : Math.round(sound - r.clicks[0]),
      spinnerAfterFirstPressMs:
        r.pendingAt === null || !r.clicks.length ? null : Math.round(r.pendingAt - r.clicks[0]),
      stillSpeakingAfterVerdict: await speaking(page, SHORT),
      clipTap: r.logs.filter((l) => l.event === 'clip.tap').length,
      clipPlay: r.logs.filter((l) => l.event === 'clip.play').length,
      fetches: fetches.filter((f) => f === SHORT).length,
      states: r.states.map((s) => `${Math.round(s.t - t0)}:${s.state}`)
    };
    record('held-capture', browserName, data);
    if (TAG === 'after') {
      expect(data.presses, 'one press is enough').toBe(1);
      expect(data.swallowedBeforeVerdict, 'no press shows nothing').toBe(0);
      expect(data.heardBeforeVerdict, 'it plays while the transcript is pending').toBe(true);
      expect(data.spinnerAfterFirstPressMs, 'the spinner shows at once').not.toBeNull();
      expect(data.spinnerAfterFirstPressMs!).toBeLessThan(300);
      expect(data.stillSpeakingAfterVerdict, 'the kept utterance did not cancel it').toBe(true);
      expect(data.clipTap).toBe(1);
    }
  } finally {
    await engine.close();
  }
});

test('play tap: a one-frame reply over a slow tunnel, pressed three times while loading', async ({
  page,
  browserName
}) => {
  test.setTimeout(60_000);
  const fetches: string[] = [];
  const engine = await startBz(fetches);
  try {
    await boot(page, engine.port, browserName);
    const t0 = await now(page);
    await press(page, SHORT, browserName);
    await page.waitForTimeout(250);
    await press(page, SHORT, browserName);
    await page.waitForTimeout(250);
    await press(page, SHORT, browserName);
    await expect.poll(() => speaking(page, SHORT), {timeout: FRAME_MS * 4 + 10_000}).toBe(true);
    const r = await rec(page);
    const sound = firstSpeaking(r, SHORT, t0)!;
    const data = {
      frameMs: FRAME_MS,
      firstPressToSoundMs: Math.round(sound - r.clicks[0]),
      spinnerAfterFirstPressMs: r.pendingAt === null ? null : Math.round(r.pendingAt - r.clicks[0]),
      loads: r.states.filter((s) => s.t >= t0 && s.state === 'loading').length,
      fetches: fetches.filter((f) => f === SHORT).length,
      outcomes: r.logs.filter((l) => l.event === 'clip.tap').map((l) => l.fields.outcome),
      states: r.states.map((s) => `${Math.round(s.t - t0)}:${s.state}`)
    };
    record('slow-one-frame', browserName, data);
    if (TAG === 'after') {
      expect(data.spinnerAfterFirstPressMs!).toBeLessThan(300);
      expect(data.loads, 'the repeat presses did not restart the load').toBe(1);
      expect(data.outcomes).toEqual(['play', 'loading', 'loading']);
      expect(data.fetches).toBe(1);
    }
  } finally {
    await engine.close();
  }
});

test('play tap: a four-frame reply over a slow tunnel plays from its first frame', async ({
  page,
  browserName
}) => {
  test.setTimeout(60_000);
  const fetches: string[] = [];
  const engine = await startBz(fetches);
  try {
    await boot(page, engine.port, browserName);
    const t0 = await now(page);
    await press(page, LONG, browserName);
    await expect.poll(() => speaking(page, LONG), {timeout: FRAME_MS * 6 + 10_000}).toBe(true);
    const r = await rec(page);
    const sound = firstSpeaking(r, LONG, t0)!;
    const data = {
      frameMs: FRAME_MS,
      frames: 4,
      firstPressToSoundMs: Math.round(sound - r.clicks[0]),
      spinnerAfterFirstPressMs: r.pendingAt === null ? null : Math.round(r.pendingAt - r.clicks[0]),
      started: r.logs.find((l) => l.event === 'clip.started')?.fields ?? null,
      streamed: r.urls.some((u) => u.t >= r.clicks[0] && /MediaSource/.test(u.kind))
    };
    record('slow-four-frames', browserName, data);
    if (TAG === 'after') {
      // Sounding before the second frame could have landed.
      expect(data.streamed, 'the player was handed a MediaSource').toBe(true);
      expect(data.firstPressToSoundMs).toBeLessThan(FRAME_MS * 2);
    }
  } finally {
    await engine.close();
  }
});
