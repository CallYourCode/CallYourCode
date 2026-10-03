import {test, expect, type Page} from '@playwright/test';
import {startTransferEngine} from '../offline/transferEngine';
import {bootVoice, fieldsOf, holdMic, micState, type Logs} from './voiceKit';

// The mic grace window. The composer keeps a just-used mic open for
// MIC_GRACE_MS so the next take reuses the granted stream: no getUserMedia
// (on an iPhone web app every call can raise the permission prompt) and the
// recorder ring's pre-roll catches the first word. A background is a hard
// release either way. The store bindings passed the release on without its
// `grace` flag, so every take released the mic at once and every press asked
// for it again (field: mic.disposed ~1s after every verdict, preRollMs=0).
//
// grep token: `mic grace`.

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

test('mic grace: a second take reuses the granted mic; a background releases it', async ({
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
      `[mic grace] ${browserName}: ` +
        JSON.stringify({
          afterFirstTake: afterFirst,
          afterSecondTake: afterSecond,
          inBackground: hidden,
          preRollMs: [Number(start1.preRollMs), Number(start2.preRollMs)]
        })
    );
    expect(afterFirst.liveTracks, 'the mic stays open for the next take').toBe(1);
    expect(afterSecond.gum, 'the second take asked for no new mic').toBe(1);
    // A warm ring (2s rotation, two staggered recorders) holds 1-2s before the
    // press; a mic opened by the press holds a few milliseconds.
    expect(Number(start2.preRollMs), 'the second take carries pre-roll').toBeGreaterThan(500);
    expect(hidden.liveTracks, 'a background releases the mic').toBe(0);
  } finally {
    await engine.close();
  }
});
