import {expect, test, type Page} from '@playwright/test';
import {bootEngines} from './rig';
import {startPresentationEngine} from './presentationEngine';

// Regression guard for the multiline composer field. Before the composer CSS->TS
// migration the field's wrap rule lived in the unlayered, high-specificity
// `.cyc-composer .cyc-composer-line .cyc-composer-input { white-space: break-spaces }`
// which beat the unlayered `[contenteditable='true'] { white-space: pre-wrap }` in
// chrome.css. The migration moved it to a *layered* `[white-space:break-spaces]`
// utility, and a layered normal declaration loses to an unlayered one -- so the
// field silently fell back to `pre-wrap`. Under `pre-wrap` trailing/preserved
// spaces do not wrap, so a wrapped multiline draft measures a different height when
// the live field autosizes and the caret can run off the trailing edge instead of
// wrapping. This proves, in real Chromium, that the field computes `break-spaces`
// again and that multiline typing wraps, autosizes past one line, and caps + scrolls
// at the pill max-height.
//
// grep token: `composer multiline`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const RICH_ROW = 'Relay Server';
// autosize measures the live field in place -- there is no measuring clone -- so the
// composer input is the single `.cyc-composer-input` node.
const INPUT = '#cyc-thread-pane .cyc-composer-input';

async function openComposer(page: Page, port: number, w = 768, h = 1024) {
  await bootEngines(page, [port], {size: {width: w, height: h}});
  await page.waitForSelector('#cyc-left-pane');
  await page.locator('.cyc-session-entry', {hasText: RICH_ROW}).first().click();
  await page.waitForSelector(INPUT);
  await page.waitForTimeout(300);
}

test('composer multiline: the field computes break-spaces, not the pre-wrap fallback', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);

    
    // that lost to `[contenteditable='true']{white-space:pre-wrap}` computes `pre-wrap`.
    const ws = await page.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel)!).whiteSpace,
      INPUT
    );
    expect(ws).toBe('break-spaces');

    // The parent flagged the pasted-`pre` inline/zero-margin utilities too. Those beat the
    // UA `pre{display:block;margin:1em 0}` (no authored unlayered rule sets pre display or
    // margin), so unlike white-space they never regressed -- prove it directly.
    const pre = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      el.innerHTML = '<pre>x</pre>';
      const p = el.querySelector('pre')!;
      const c = getComputedStyle(p);
      const out = {display: c.display, marginTop: c.marginTop, marginBottom: c.marginBottom};
      el.replaceChildren();
      return out;
    }, INPUT);
    expect(pre.display).toBe('inline');
    expect(pre.marginTop).toBe('0px');
    expect(pre.marginBottom).toBe('0px');
  } finally {
    await eng.close();
  }
});

test('composer multiline: Shift+Enter lines autosize the field past one line', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);

    const height = () =>
      page.evaluate(
        (sel) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().height,
        INPUT
      );

    await page.locator(INPUT).click();
    const oneLine = await height();

    // Three hard lines via Shift+Enter (the composer keeps Enter for send).
    await page.keyboard.type('line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line three');
    await page.waitForTimeout(200);

    const threeLines = await height();
    // The field grew to hold the extra lines (autosize measured the taller live field).
    expect(threeLines).toBeGreaterThan(oneLine + 20);

    // The draft round-trips all three lines.
    const text = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement).innerText,
      INPUT
    );
    expect(text.replace(/\r/g, '')).toContain('line one');
    expect(text).toContain('line two');
    expect(text).toContain('line three');
  } finally {
    await eng.close();
  }
});

test('composer multiline: the visible field width never shrinks as autosize grows its height', async ({
  page
}) => {
  // The property this guards. autosize() pins the live field `relative` inline so it stays in
  // the `.cyc-composer-field` flex row and measures itself in place -- collapsing its inline
  // height to read `scrollHeight`, then writing the height back. Growing the height (each
  // Shift+Enter line, and especially a long wrapped run) must never touch the field's width:
  // an earlier regression, where a stray positioned measuring node re-entered the flex row,
  // stole flex width and halved the visible field (~681px empty collapsing to ~266px on a
  // long line). With the live field measured in place the visible width is rock-steady.
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);

    const metrics = () =>
      page.evaluate((i) => {
        const inp = document.querySelector(i) as HTMLElement;
        return {
          width: Math.round(inp.getBoundingClientRect().width * 100) / 100,
          height: Math.round(inp.getBoundingClientRect().height * 100) / 100
        };
      }, INPUT);

    await page.locator(INPUT).click();

    const empty = await metrics();
    const baseWidth = empty.width;
    expect(baseWidth).toBeGreaterThan(100);

    // A ~1px tolerance: under the regression the width fell by tens of px per stage (down to
    // ~266px); the field does not move at all as content grows.
    const stable = (w: number, where: string) =>
      expect(Math.abs(w - baseWidth), `field width drifted at ${where}`).toBeLessThanOrEqual(1);

    // Repeated Shift+Enter newline insertion: width holds, height climbs.
    await page.keyboard.type('line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    const two = await metrics();
    stable(two.width, 'two lines');

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line three');
    await page.waitForTimeout(150);
    const three = await metrics();
    stable(three.width, 'three lines');
    expect(three.height).toBeGreaterThan(empty.height + 20); // autosize grew past one line

    // A long unbreakable-ish run that must wrap: this is what collapsed the field to ~266px.
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(
      'this is a very long line that should wrap across the field because it far exceeds the ' +
        'visible width of the composer input area by a comfortable margin indeed yes it does'
    );
    await page.waitForTimeout(200);
    const long = await metrics();
    stable(long.width, 'long wrapped line');
    expect(long.height).toBeGreaterThan(three.height); // wrapping added rows

    // Stage a real attachment through the live picker path (same trigger composer-states'
    // staged-file spec uses), not a hand-built chip. The chip renders in the blocks row
    // above the field; the field's own width must be untouched by it.
    await page
      .locator('#cyc-thread-pane .cyc-composer input[type=file]')
      .first()
      .setInputFiles({name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hi there')});
    await page.waitForSelector('#cyc-thread-pane .cyc-attach-chip');
    await page.waitForTimeout(150);
    const withChip = await metrics();
    stable(withChip.width, 'with attachment chip');

    // Keep typing after the chip lands: still stable, still growing.
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('after the attachment');
    await page.waitForTimeout(150);
    const afterChip = await metrics();
    stable(afterChip.width, 'more lines after chip');
    expect(afterChip.height).toBeGreaterThanOrEqual(withChip.height);

    // Remove the attachment via its real remove cross; the draft text and field width remain.
    await page.locator('#cyc-thread-pane .cyc-attach-chip .cyc-attach-remove').first().click();
    await page.waitForSelector('#cyc-thread-pane .cyc-attach-chip', {state: 'detached'});
    await page.waitForTimeout(150);
    const removed = await metrics();
    stable(removed.width, 'after removing attachment');

    const text = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement).innerText,
      INPUT
    );
    expect(text).toContain('line one');
    expect(text).toContain('after the attachment');
  } finally {
    await eng.close();
  }
});

test('composer field skin: the final placeholder reveal computes in Chromium', async ({page}) => {
  // The field's skin moved off the unlayered settings.css onto its producer as *layered*
  // utilities. This proves, in real Chromium, that the empty placeholder still reveals at
  // its declared opacity, out of flow and inert, and hides once text is typed. (The old
  // measuring clone was deleted -- autosize now measures the live field in place -- so
  // there is no clone skin left to assert here.)
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);
    const PLACEHOLDER = '#cyc-thread-pane .cyc-field-placeholder';

    // Empty composer: the placeholder is revealed (cyc-empty), out of flow and inert.
    const empty = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const c = getComputedStyle(el);
      return {
        opacity: c.opacity,
        position: c.position,
        pointerEvents: c.pointerEvents,
        whiteSpace: c.whiteSpace,
        textOverflow: c.textOverflow,
        hasEmpty: el.classList.contains('cyc-empty')
      };
    }, PLACEHOLDER);
    expect(empty.hasEmpty).toBe(true);
    // The revealed value is the producer's own `[&.cyc-empty]:opacity-75` (composerField.ts);
    // the oracle composer baselines are captured at this same opacity.
    expect(empty.opacity).toBe('0.75');
    expect(empty.position).toBe('absolute');
    expect(empty.pointerEvents).toBe('none');
    expect(empty.whiteSpace).toBe('nowrap');
    expect(empty.textOverflow).toBe('ellipsis');

    // Type: the placeholder loses cyc-empty and fades back out.
    await page.locator(INPUT).click();
    await page.keyboard.type('a draft');
    await page.waitForTimeout(250);
    const filled = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      return {opacity: getComputedStyle(el).opacity, hasEmpty: el.classList.contains('cyc-empty')};
    }, PLACEHOLDER);
    expect(filled.hasEmpty).toBe(false);
    expect(filled.opacity).toBe('0');
  } finally {
    await eng.close();
  }
});

test('composer multiline: a tall draft caps at the pill max-height and scrolls', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);

    await page.locator(INPUT).click();
    // Enough hard lines to exceed the capped field height.
    for (let i = 0; i < 24; i++) {
      await page.keyboard.type(`row ${i}`);
      await page.keyboard.press('Shift+Enter');
    }
    await page.waitForTimeout(250);

    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const c = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        maxHeight: parseFloat(c.maxHeight),
        overflowY: c.overflowY,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      };
    }, INPUT);

    // Capped at the max-height (`max-h-[calc(var(--cyc-pill-max)-1rem)]`) and scrollable.
    expect(box.maxHeight).toBeGreaterThan(0);
    expect(box.height).toBeLessThanOrEqual(box.maxHeight + 1);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 4);
    expect(box.overflowY).toBe('auto');
  } finally {
    await eng.close();
  }
});
