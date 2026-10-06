import {expect, test, type Page} from '@playwright/test';
import {startScrollEngine} from './scrollEngine';
import {bootAndOpen, mustRect, SCROLL} from './chatGeom';

// DRAWER CLOSE (fix-drawer-close). The owner, Android tablet in portrait
// (2026-10-06): "I tap Back in a chat, the list comes in on the left with the
// chat still showing on the right, and tapping the chat does not take me back
// to it; I have to tap the agent in the list." The contract, per viewport:
//   - tablet portrait (touch) and a half-width laptop window (mouse): after
//     Back, a press on the visible chat beside the list returns to the chat,
//     and the press does not also work the control under it (a press on the
//     composer does not focus the input);
//   - phone: the list covers the chat, so the covered chat takes no press.
// grep token: `drawer close`.

const VIEWS = [
  {label: 'tablet', size: {width: 800, height: 1280}, scale: 2, touch: true},
  {label: 'half', size: {width: 790, height: 900}, scale: 1, touch: false}
] as const;
type View = (typeof VIEWS)[number] | typeof PHONE;
const PHONE = {label: 'phone', size: {width: 393, height: 852}, scale: 3, touch: true} as const;

const COLS = '#cyc-columns';
const INPUT = '#cyc-thread-pane .cyc-composer-input';
const BACK = '.cyc-mast .cyc-pane-back';

async function press(page: Page, view: View, x: number, y: number) {
  if (view.touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

const viewOf = (page: Page) => page.$eval(COLS, (e) => (e as HTMLElement).dataset.view);
const inputFocused = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.classList.contains('cyc-composer-input'));

async function back(page: Page, view: View) {
  const r = await mustRect(page, BACK);
  await press(page, view, r.x + r.width / 2, r.y + r.height / 2);
  await expect.poll(() => viewOf(page)).toBe('list');
  // The drawer slides in over 0.2 s.
  await page.waitForTimeout(400);
}

// A point on `sel` that is in view beside the list drawer.
async function besideList(page: Page, sel: string): Promise<{x: number; y: number}> {
  const list = await mustRect(page, '#cyc-left-pane');
  const r = await mustRect(page, sel);
  const x = Math.max(r.x, list.right) + 30;
  expect(x, `${sel} is not in view beside the list`).toBeLessThan(r.right - 10);
  return {x, y: r.y + r.height / 2};
}

async function withOpenChat(page: Page, view: View, run: () => Promise<void>) {
  const eng = await startScrollEngine({count: 60});
  try {
    await bootAndOpen(page, eng, view);
    expect(await viewOf(page)).toBe('chat');
    await run();
  } finally {
    await eng.close();
  }
}

for (const view of VIEWS) {
  test.describe(view.label, () => {
    test.use({
      viewport: view.size,
      deviceScaleFactor: view.scale,
      hasTouch: view.touch,
      isMobile: view.touch
    });

    test(`drawer close (${view.label}): after Back, a press on the visible chat returns to it`, async ({
      page
    }) => {
      await withOpenChat(page, view, async () => {
        await back(page, view);
        const at = await besideList(page, SCROLL);
        await press(page, view, at.x, at.y);
        await expect
          .poll(() => viewOf(page), {message: 'a press on the visible chat left the list open'})
          .toBe('chat');
      });
    });

    test(`drawer close (${view.label}): the press that returns to the chat does not also work the control under it`, async ({
      page
    }) => {
      await withOpenChat(page, view, async () => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        await back(page, view);
        const at = await besideList(page, INPUT);
        await press(page, view, at.x, at.y);
        await expect
          .poll(() => viewOf(page), {message: 'a press on the composer left the list open'})
          .toBe('chat');
        await page.waitForTimeout(300);
        expect(await inputFocused(page), 'the press that closed the list also focused the input').toBe(
          false
        );
      });
    });
  });
}

test.describe(PHONE.label, () => {
  test.use({
    viewport: PHONE.size,
    deviceScaleFactor: PHONE.scale,
    hasTouch: PHONE.touch,
    isMobile: PHONE.touch
  });

  test('drawer close (phone): the list covers the chat, and the covered chat takes no press', async ({
    page
  }) => {
    await withOpenChat(page, PHONE, async () => {
      await back(page, PHONE);
      const hit = await page.evaluate(() => {
        const pane = document.getElementById('cyc-thread-pane')!;
        const x = window.innerWidth / 2;
        const y = window.innerHeight / 2;
        return {
          pointerEvents: getComputedStyle(pane).pointerEvents,
          inChat: !!document.elementFromPoint(x, y)?.closest('#cyc-thread-pane')
        };
      });
      expect(hit.pointerEvents, 'the covered chat pane takes presses').toBe('none');
      expect(hit.inChat, 'a press mid-screen lands in the covered chat').toBe(false);
    });
  });
});
