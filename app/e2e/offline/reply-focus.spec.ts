import {expect, test, type Page} from '@playwright/test';
import {startScrollEngine, type ScrollEngine} from './scrollEngine';
import {bootAndOpen, mustRect, SCROLL, type Rect} from './chatGeom';

// CLICKING THE INPUT ALWAYS FOCUSES IT, IN EVERY LAYOUT (fix-reply-focus). The
// owner, laptop Chrome in a half-width window (2026-10-03): "if I hit reply on
// an earlier message and try to click into the input box, I cannot focus on it
// anymore". The contract, per viewport (phone with touch, the half-width window
// with a mouse, a laptop window with a mouse):
//   - after Reply on an earlier message, a press on the composer focuses the
//     input, typing lands in it, and the reply preview stays. That holds for a
//     press on the text line AND on the pill's bare surface around it (the band
//     between the reply card and the text, the strip under the text): the pill
//     is the input box;
//   - a chat that is on screen takes the press: the half-width drawer leaves the
//     chat in view beside the list, and a laptop window shows them side by side
//     (on a phone the list covers the chat, which stays inert);
//   - menu or sheet is an input-device choice, never a width one: a mouse gets
//     the attach menu at every width, touch gets the sheet.
// Runs in Chromium here and in Chromium + WebKit under reply-focus.config.ts.
// grep token: `reply focus`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const VIEWS = [
  {label: 'phone', size: {width: 393, height: 852}, scale: 3, touch: true},
  {label: 'half', size: {width: 790, height: 900}, scale: 1, touch: false},
  {label: 'laptop', size: {width: 1280, height: 900}, scale: 1, touch: false}
] as const;
type View = (typeof VIEWS)[number];

const HALF = VIEWS[1].size;
const COLUMNS = '#cyc-columns';
const INPUT = '#cyc-thread-pane .cyc-composer-input';
const LINE = '#cyc-thread-pane .cyc-composer-line';
const REPLY_CARD = '#cyc-thread-pane .cyc-block-reply';
const BACK = '#cyc-thread-pane .cyc-pane-header .cyc-pane-back';

async function press(page: Page, view: View, x: number, y: number) {
  if (view.touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await expect.poll(() => inputFocused(page)).toBe(false);
}

const inputFocused = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.classList.contains('cyc-composer-input'));

// The centre of an agent bubble's text, fully inside the visible scroller.
async function earlierBubble(page: Page): Promise<{x: number; y: number}> {
  const at = await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    const box = s.getBoundingClientRect();
    for (const t of s.querySelectorAll<HTMLElement>('.cyc-msg-received .cyc-message-text')) {
      const r = t.getBoundingClientRect();
      if (r.height && r.top > box.top + 80 && r.bottom < box.bottom - 160) {
        return {x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2};
      }
    }
    return null;
  }, SCROLL);
  expect(at, 'no agent bubble fully on screen to reply to').not.toBeNull();
  return at!;
}

// Reply on an earlier message the way the device does it: a right-click menu
// for a mouse, the long-press menu for touch.
async function replyToEarlier(page: Page, view: View) {
  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = Math.max(0, s.scrollTop - 1500);
  }, SCROLL);
  await page.waitForTimeout(400);
  const at = await earlierBubble(page);
  if (view.touch) {
    // A long press on the bubble text (touchSelection raises the menu at 1s).
    const fire = (type: string) =>
      page.evaluate(
        ({type, x, y}) => {
          const target = document.elementFromPoint(x, y)!;
          const ev = new Event(type, {bubbles: true, cancelable: true});
          const touches = type === 'touchend' ? [] : [{identifier: 1, target, clientX: x, clientY: y}];
          Object.defineProperty(ev, 'touches', {value: touches});
          target.dispatchEvent(ev);
        },
        {type, ...at}
      );
    await fire('touchstart');
    await page.waitForTimeout(1150);
    await fire('touchend');
  } else {
    await page.mouse.click(at.x, at.y, {button: 'right'});
  }
  // The menu item itself is not under test here. A plain click picks it in
  // both engines; WebKit's emulated touchscreen tap on it did not.
  await page.locator('.cyc-menu[data-cyc-phase="open"] .cyc-menu-item', {hasText: 'Reply'}).click();
  await expect(page.locator(REPLY_CARD)).toHaveCount(1);
  await page.waitForTimeout(300);
}

async function expectTypingLands(page: Page, text: string) {
  await page.keyboard.type(text);
  await expect(page.locator(INPUT)).toContainText(text);
  await expect(page.locator(REPLY_CARD), 'the reply preview went away').toHaveCount(1);
}

async function withEngine(run: (eng: ScrollEngine) => Promise<void>) {
  const eng = await startScrollEngine({count: 60});
  try {
    await run(eng);
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

    test(`reply focus (${view.label}): after Reply, a press on the text line or the pill around it focuses the input`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      await withEngine(async (eng) => {
        await bootAndOpen(page, eng, view);
        await replyToEarlier(page, view);

        const card = await mustRect(page, REPLY_CARD);
        const line = await mustRect(page, LINE);
        const input = await mustRect(page, INPUT);
        const x = input.x + input.width / 3;
        const points: [string, number, number][] = [
          ['the text line', x, input.y + input.height / 2],
          ['the band between the reply card and the text', x, (card.bottom + input.y) / 2],
          ['the strip under the text', x, (input.bottom + line.bottom) / 2]
        ];
        let typed = 0;
        for (const [where, px, py] of points) {
          await blur(page);
          await press(page, view, px, py);
          await expect
            .poll(() => inputFocused(page), {message: `a press on ${where} did not focus the input`})
            .toBe(true);
          await expectTypingLands(page, ` w${typed++}`);
        }
      });
    });

    if (view.touch) {
      test(`reply focus (${view.label}): the chat stays inert while the list covers it`, async ({
        page
      }) => {
        test.setTimeout(90_000);
        await withEngine(async (eng) => {
          await bootAndOpen(page, eng, view);
          await page.locator(BACK).click();
          await expect(page.locator(COLUMNS)).toHaveAttribute('data-view', 'list');
          const pe = await page.evaluate(
            () => getComputedStyle(document.querySelector('#cyc-thread-pane')!).pointerEvents
          );
          expect(pe, 'the chat hidden under the phone list takes presses').toBe('none');
        });
      });
    } else {
      test(`reply focus (${view.label}): the chat in view beside the open list takes the press`, async ({
        page
      }) => {
        test.setTimeout(90_000);
        await withEngine(async (eng) => {
          // The half-width window, where the list is a drawer over the chat.
          if (view.label !== 'half') await page.setViewportSize(HALF);
          await bootAndOpen(page, eng, {...view, size: HALF});
          await replyToEarlier(page, view);
          await page.locator(BACK).click();
          await expect(page.locator(COLUMNS)).toHaveAttribute('data-view', 'list');
          // The laptop window: widen it with the list still holding the view,
          // so the chat sits beside it.
          if (view.label !== 'half') await page.setViewportSize(view.size);
          await page.waitForTimeout(400);

          const input: Rect = await mustRect(page, INPUT);
          const x = Math.min(input.x + 40, view.size.width - 10);
          const y = input.y + input.height / 2;
          expect(x, 'the composer is not on screen beside the list').toBeLessThan(view.size.width);
          await blur(page);
          await press(page, view, x, y);
          await expect
            .poll(() => inputFocused(page), {message: 'the visible composer did not take the press'})
            .toBe(true);
          await expectTypingLands(page, ' beside');
          // At half width the press on the chat also closes the drawer.
          if (view.label === 'half') await expect(page.locator(COLUMNS)).toHaveAttribute('data-view', 'chat');
        });
      });
    }

    test(`reply focus (${view.label}): the attach button opens the ${view.touch ? 'sheet' : 'menu'}`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      await withEngine(async (eng) => {
        await bootAndOpen(page, eng, view);
        const btn = await mustRect(page, '#cyc-thread-pane .cyc-attach-btn');
        await press(page, view, btn.x + btn.width / 2, btn.y + btn.height / 2);
        const want = view.touch ? '.cyc-sheet' : '.cyc-menu-context';
        const not = view.touch ? '.cyc-menu-context' : '.cyc-sheet';
        await expect(page.locator(`${want}[data-cyc-phase="open"]`)).toHaveCount(1);
        await expect(page.locator(`${not}[data-cyc-phase="open"]`)).toHaveCount(0);
      });
    });
  });
}
