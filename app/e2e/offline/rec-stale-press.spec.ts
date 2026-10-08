import {expect, test, type Page} from '@playwright/test';
import {bootEngines, evidenceShot} from './rig';
import {startPresentationEngine} from './presentationEngine';

// The owner's iPhone, 2026-10-08 09:19 and 09:53: a press on the send button
// with words in the box armed a press-to-record hold, then no pointerup or
// pointercancel for that finger ever reached the page. The record bar, the lock
// chip and the mic stayed up, iOS later muted the track (`mic.reacquire
// muted:true`), and every later press on the mic was refused as a second
// finger, so only a force-close freed the box. Here the lost release is
// reproduced by never sending it, and the iOS mute by firing 'mute' on the live
// track: the next press on the mic must end that hold, keep its take in the box
// and free the composer.
//
// grep token: `rec stale press`.

test.use({timezoneId: 'UTC', locale: 'en-US', hasTouch: true});

const RICH_ROW = 'Relay Server';

// The rig's fake microphone (an oscillator through a MediaStreamDestination, a
// real capture track, so the real pipeline and MediaRecorder run), with every
// track it hands out kept for the spec to mute.
async function keepMicTracks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {__recTracks: MediaStreamTrack[]};
    w.__recTracks = [];
    let inner: (c?: MediaStreamConstraints) => Promise<MediaStream> = () =>
      Promise.reject(new Error('no microphone'));
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      get: () => async (c?: MediaStreamConstraints) => {
        const stream = await inner(c);
        w.__recTracks.push(...stream.getAudioTracks());
        return stream;
      },
      set: (fn) => {
        inner = fn;
      }
    });
  });
}

async function pointer(page: Page, type: string, pointerId: number) {
  await page.evaluate(
    ([t, id]) => {
      const btn = document.querySelector('#cyc-thread-pane .cyc-send-btn') as HTMLElement;
      const r = btn.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        pointerId: id as number,
        pointerType: 'touch',
        isPrimary: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2
      };
      (t === 'pointerdown' ? btn : document).dispatchEvent(new PointerEvent(t as string, init));
    },
    [type, pointerId] as const
  );
}

test('rec stale press: a hold whose release never came is ended by the next press on the mic', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await keepMicTracks(page);
    await bootEngines(page, [eng.port], {size: {width: 390, height: 844}});
    await page.locator('.cyc-session-entry', {hasText: RICH_ROW}).first().click();
    await page.waitForSelector('#cyc-thread-pane .cyc-composer');
    const composer = page.locator('#cyc-thread-pane .cyc-composer');

    await page.locator('#cyc-thread-pane .cyc-composer-input').click();
    await page.keyboard.type('meant to send this');
    await expect(page.locator('#cyc-thread-pane .cyc-send-btn')).toHaveAttribute(
      'data-cyc-send-mode',
      'send'
    );

    // The press: held past the hold time, and its release never arrives.
    await pointer(page, 'pointerdown', 7);
    await expect(composer).toHaveAttribute('data-cyc-recording', '', {timeout: 5_000});
    await expect
      .poll(() =>
        page.evaluate(() => (window as never as {__recTracks: unknown[]}).__recTracks.length)
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(2_000);

    // iOS mutes the track (another app, the app switcher).
    await page.evaluate(() => {
      for (const t of (window as never as {__recTracks: MediaStreamTrack[]}).__recTracks)
        t.dispatchEvent(new Event('mute'));
    });
    await page.waitForTimeout(1_000);
    await evidenceShot(page, '', 'rec-stale-press-stuck');

    // The user taps the mic again.
    await pointer(page, 'pointerdown', 8);
    await pointer(page, 'pointerup', 8);

    await expect(composer).not.toHaveAttribute('data-cyc-recording', /.*/, {timeout: 3_000});
    await expect(page.locator('#cyc-thread-pane .cyc-composer .cyc-block-voice')).toHaveCount(1, {
      timeout: 5_000
    });
    await expect(page.locator('#cyc-thread-pane .cyc-composer-input')).toHaveText(
      'meant to send this'
    );
    await evidenceShot(page, '', 'rec-stale-press-freed');
  } finally {
    await eng.close();
  }
});
