import {test, expect, type Page} from '@playwright/test';
import {startTransferEngine} from '../offline/transferEngine';
import {bootVoice, fieldsOf, holdMic, micState, type Logs} from './voiceKit';

// The mic is held only while used. Each take releases it as soon as its
// capture settles, so between takes no track is live (on an iPhone: no mic
// indicator, no play-and-record session around reply playback) and the next
// press opens the mic afresh. That costs the pre-roll a warm recorder ring
// would give. A background releases it too. This is the phone's field
// behaviour since 2026-08-24, now intended on every platform.
//
// grep token: `mic release`.

const VISIBILITY = () => {
  let vis: DocumentVisibilityState = 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => vis
  });
  Object.defineProperty(Document.prototype, 'hidden', {
    configurable: true,
    get: () => vis !== 'visible'
  });
  (window as unknown as {__vrHide: () => void}).__vrHide = () => {
    vis = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  };
};

async function takeOnce(page: Page, logs: Logs): Promise<Record<string, string>> {
  const from = logs.lines.length;
  await holdMic(page, () => page.waitForTimeout(2_000));
  await expect
    .poll(() => logs.lines.slice(from).some((l) => l.includes(' app capture.verdict ')), {
      timeout: 40_000
    })
    .toBe(true);
  // Let the release that follows a settled take run.
  await page.waitForTimeout(1_500);
  return fieldsOf(logs.lines.slice(from).find((l) => l.includes(' app capture.start '))!);
}

test('mic release: each take releases the mic; the next press opens it afresh', async ({
  page,
  browserName
}) => {
  const engine = await startTransferEngine({});
  try {
    const logs = await bootVoice(page, engine.port, {init: () => page.addInitScript(VISIBILITY)});
    const start1 = await takeOnce(page, logs);
    const afterFirst = await micState(page);
    const start2 = await takeOnce(page, logs);
    const afterSecond = await micState(page);
    await page.evaluate(() => (window as unknown as {__vrHide: () => void}).__vrHide());
    await page.waitForTimeout(1_000);
    const hidden = await micState(page);
    console.log(
      `[mic release] ${browserName}: ` +
        JSON.stringify({
          afterFirstTake: afterFirst,
          afterSecondTake: afterSecond,
          inBackground: hidden,
          preRollMs: [Number(start1.preRollMs), Number(start2.preRollMs)]
        })
    );
    expect(afterFirst.liveTracks, 'no track is live once the take settled').toBe(0);
    expect(afterSecond.gum, 'the second press opened the mic afresh').toBe(2);
    expect(afterSecond.liveTracks).toBe(0);
    expect(hidden.liveTracks).toBe(0);
  } finally {
    await engine.close();
  }
});
