import {expect, test, type Page} from '@playwright/test';
import {startScrollEngine, type ScrollEngine} from './scrollEngine';
import {bootAndOpen, mustRect, SCROLL} from './chatGeom';

// THE PILL IS THE INPUT BOX (fix-box-focus-min). The owner, laptop Chrome in a
// half-width window (2026-10-03): "I hit reply on an earlier message and click
// into the message box, and it won't focus." Only the text line took the
// press; the band under the reply card, the strips above and below the text
// and the line's padding were dead and even blurred the input. The contract,
// per viewport (phone with touch, the half-width window and the owner's laptop
// window with a mouse):
//   - after Reply on an earlier message, a press on the text line, the band
//     between the reply card and the text, the strip under the text or the
//     line's start padding focuses the input, typing lands in it, and the reply
//     preview stays;
//   - after Quote, a press on the quote card (its text or its title) focuses the
//     input too: anything on the composer's surface that is not a control is
//     the input box.
// grep token: `reply focus`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const VIEWS = [
  {label: 'phone', size: {width: 393, height: 852}, scale: 3, touch: true},
  {label: 'half', size: {width: 790, height: 900}, scale: 1, touch: false},
  {label: 'laptop', size: {width: 1133, height: 900}, scale: 1, touch: false}
] as const;
type View = (typeof VIEWS)[number];

const INPUT = '#cyc-thread-pane .cyc-composer-input';
const LINE = '#cyc-thread-pane .cyc-composer-line';
const REPLY_CARD = '#cyc-thread-pane .cyc-block-reply';
const QUOTE_CARD = '#cyc-thread-pane .cyc-block-quote';

async function centre(page: Page, sel: string): Promise<{x: number; y: number}> {
  const r = await mustRect(page, sel);
  return {x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2};
}

// A stamp's quote button on an agent bubble fully on screen.
async function stampQuote(page: Page): Promise<{x: number; y: number}> {
  const at = await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    const box = s.getBoundingClientRect();
    for (const b of s.querySelectorAll<HTMLElement>('.cyc-msg-received .cyc-stamp-act[data-act="quote"]')) {
      const r = b.getBoundingClientRect();
      if (r.height && r.top > box.top + 80 && r.bottom < box.bottom - 160) {
        return {x: r.left + r.width / 2, y: r.top + r.height / 2};
      }
    }
    return null;
  }, SCROLL);
  expect(at, 'no quote button on an agent bubble fully on screen').not.toBeNull();
  return at!;
}

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

async function scrollBack(page: Page) {
  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = Math.max(0, s.scrollTop - 1500);
  }, SCROLL);
  await page.waitForTimeout(400);
}

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
  await scrollBack(page);
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
  // The menu item itself is not under test here; a plain click picks it.
  await page.locator('.cyc-menu[data-cyc-phase="open"] .cyc-menu-item', {hasText: 'Reply'}).click();
  await expect(page.locator(REPLY_CARD)).toHaveCount(1);
  await page.waitForTimeout(300);
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

    test(`reply focus (${view.label}): after Reply, a press anywhere on the box around the text focuses the input`, async ({
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
          ['the strip under the text', x, (input.bottom + line.bottom) / 2],
          ["the line's start padding", line.x + 4, input.y + input.height / 2]
        ];
        let typed = 0;
        for (const [where, px, py] of points) {
          await blur(page);
          await press(page, view, px, py);
          await expect
            .poll(() => inputFocused(page), {message: `a press on ${where} did not focus the input`})
            .toBe(true);
          await page.keyboard.type(` w${typed}`);
          await expect(page.locator(INPUT)).toContainText(` w${typed++}`);
          await expect(page.locator(REPLY_CARD), 'the reply preview went away').toHaveCount(1);
        }
      });
    });

    test(`reply focus (${view.label}): after Quote, a press on the quote card focuses the input`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      await withEngine(async (eng) => {
        await bootAndOpen(page, eng, view);
        await scrollBack(page);
        // The stamp button is not under test: a plain click picks it.
        const q = await stampQuote(page);
        await page.mouse.click(q.x, q.y);
        await expect(page.locator(QUOTE_CARD)).toHaveCount(1);
        let typed = 0;
        for (const [where, sel] of [
          ['the quote text', `${QUOTE_CARD} .cyc-block-quote-text`],
          ['the quote title', `${QUOTE_CARD} .cyc-block-quote-from`]
        ] as const) {
          await blur(page);
          const at = await centre(page, sel);
          await press(page, view, at.x, at.y);
          await expect
            .poll(() => inputFocused(page), {message: `a press on ${where} did not focus the input`})
            .toBe(true);
          await page.keyboard.type(` q${typed}`);
          await expect(page.locator(INPUT)).toContainText(` q${typed++}`);
          await expect(page.locator(QUOTE_CARD), 'the quote went away').toHaveCount(1);
        }
      });
    });
  });
}
