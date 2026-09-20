import {expect, test, type Page} from '@playwright/test';
import {bootEngines} from './rig';
import {startPresentationEngine} from './presentationEngine';

// Real-browser computed-style coverage for the composer states the migration
// oracle does not frame (it only captures the empty resting pill). Every check
// reads getComputedStyle in a live Chromium so it proves the *cascade* -- the

// skin -- rather than merely echoing a class string. This is what caught the lock
// chip slipping back into flow and shoving the send button.
//
// grep token: `composer states`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const RICH_ROW = 'Relay Server';

async function openComposer(page: Page, port: number, w = 768, h = 1024) {
  await bootEngines(page, [port], {size: {width: w, height: h}});
  await page.waitForSelector('#cyc-left-pane');
  await page.locator('.cyc-session-entry', {hasText: RICH_ROW}).first().click();
  await page.waitForSelector('#cyc-thread-pane .cyc-composer');
  await page.waitForTimeout(300);
}

// Read computed props for one selector inside the composer.
async function css(page: Page, selector: string, props: string[]) {
  return page.evaluate(
    ([sel, ps]) => {
      const el = document.querySelector(sel as string);
      if (!el) return null;
      const c = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const p of ps as string[]) out[p] = c.getPropertyValue(p);
      const r = (el as HTMLElement).getBoundingClientRect();
      out.__w = String(Math.round(r.width * 100) / 100);
      out.__h = String(Math.round(r.height * 100) / 100);
      out.__right = String(Math.round(r.right * 100) / 100);
      return out;
    },
    [selector, props] as const
  );
}

const px = (v: string | undefined) => parseFloat(v ?? 'NaN');

test('composer states: resting send/attach/lock geometry (unlayered cascade)', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);

    // Was `html body .cyc-send-btn` 2.25rem box + `--cyc-fill-color` fill / white ink
    // (root font is 16px here, so 2.25rem = 36px).
    const send = await css(page, '#cyc-thread-pane .cyc-send-btn', [
      'background-color',
      'color',
      'padding'
    ]);
    expect(px(send?.__w)).toBeCloseTo(36, 0);
    expect(px(send?.__h)).toBeCloseTo(36, 0);
    expect(send?.padding).toBe('0px');
    // A real fill (not transparent) with white ink -- the `!` utilities won.
    expect(send?.['background-color']).not.toBe('rgba(0, 0, 0, 0)');
    expect(send?.color).toBe('rgb(255, 255, 255)');

    // Was `.cyc-composer-rows .cyc-icon-btn` (2.5rem box, padding 0).
    const attach = await css(page, '#cyc-thread-pane .cyc-attach-btn', ['padding']);
    expect(px(attach?.__w)).toBeCloseTo(40, 0); // 2.5rem
    expect(attach?.padding).toBe('0px');

    // THE guard: the lock chip must be display:none at rest. A layered `hidden`
    // loses to the unlayered `.cyc-icon-btn{display:flex}`; only `hidden!` wins.
    // If it regresses the chip re-enters flow and drags the send button left.
    const lock = await page.evaluate(() => {
      const el = document.querySelector('#cyc-thread-pane .cyc-rec-lock') as HTMLElement | null;
      return el ? {display: getComputedStyle(el).display, offsetParent: !!el.offsetParent} : null;
    });
    expect(lock?.display).toBe('none');
    expect(lock?.offsetParent).toBe(false);

    // With the lock chip out of flow, the send box sits flush at the cluster's
    // trailing edge (0.375rem inset), so it very nearly reaches the pill's edge.
    const box = await css(page, '#cyc-thread-pane .cyc-send-box', []);
    const pill = await css(page, '#cyc-thread-pane .cyc-composer-rows', []);
    expect(px(pill?.__right) - px(box?.__right)).toBeLessThan(8);
  } finally {
    await eng.close();
  }
});

test('composer states: disabled locks and mutes, never dims', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);
    await page.evaluate(() =>
      document
        .querySelector('#cyc-thread-pane .cyc-composer')!
        .classList.add('cyc-composer-disabled')
    );
    await page.waitForTimeout(260); // let the colour transition settle
    // A dead session must not read as see-through: the pill and the send box
    // stay fully opaque (bubbles behind never bleed into the input) and the
    // surface stays the opaque composer surface.
    const rows = await css(page, '#cyc-thread-pane .cyc-composer-rows', [
      'opacity',
      'background-color'
    ]);
    const box = await css(page, '#cyc-thread-pane .cyc-send-box', ['opacity', 'pointer-events']);
    const input = await css(page, '#cyc-thread-pane .cyc-composer-input', ['pointer-events']);
    const attach = await css(page, '#cyc-thread-pane .cyc-attach-btn', ['pointer-events', 'color']);
    const send = await css(page, '#cyc-thread-pane .cyc-send-btn', ['color']);
    const muted = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--cyc-text-muted)';
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(px(rows?.opacity)).toBeCloseTo(1, 2);
    expect(rows?.['background-color']).not.toBe('rgba(0, 0, 0, 0)');
    expect(rows?.['background-color']).not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)$/);
    expect(px(box?.opacity)).toBeCloseTo(1, 2);
    expect(box?.['pointer-events']).toBe('none');
    expect(input?.['pointer-events']).toBe('none');
    expect(attach?.['pointer-events']).toBe('none');
    // Locked signals through muted ink, not transparency.
    expect(attach?.color).toBe(muted);
    expect(send?.color).toBe(muted);
    expect(send?.color).not.toBe('rgb(255, 255, 255)');
  } finally {
    await eng.close();
  }
});

test('composer states: recording reveals the panel + lock chip and hides attach', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);
    await page.evaluate(() =>
      document
        .querySelector('#cyc-thread-pane .cyc-composer')!
        .toggleAttribute('data-cyc-recording', true)
    );
    await page.waitForTimeout(260); // let the opacity/visibility transitions settle
    const panel = await css(page, '#cyc-thread-pane .cyc-rec-panel', ['visibility', 'opacity']);
    expect(panel?.visibility).toBe('visible');
    expect(px(panel?.opacity)).toBeCloseTo(1, 2);

    // Lock chip flips to flex (its `flex!` beats the resting `hidden!`).
    const lock = await css(page, '#cyc-thread-pane .cyc-rec-lock', ['display']);
    expect(lock?.display).toBe('flex');

    // The recording dot pulses a danger ring (transform + box-shadow, no opacity
    // dip) and shows. Its resting opacity stays fully opaque.
    const dot = await css(page, '#cyc-thread-pane .cyc-rec-dot', [
      'display',
      'animation-name',
      'opacity'
    ]);
    expect(dot?.display).not.toBe('none');
    expect(dot?.['animation-name']).toBe('cyc-rec-dot-ring');
    expect(px(dot?.opacity)).toBeCloseTo(1, 2);

    // Attach folds away while recording.
    const attach = await css(page, '#cyc-thread-pane .cyc-attach-btn', [
      'opacity',
      'pointer-events'
    ]);
    expect(px(attach?.opacity)).toBeCloseTo(0, 2);
    expect(attach?.['pointer-events']).toBe('none');

    // The danger glow behind the send button lights up.
    const glow = await css(page, '#cyc-thread-pane .cyc-send-glow', ['opacity']);
    expect(px(glow?.opacity)).toBeGreaterThan(0);
  } finally {
    await eng.close();
  }
});

test('composer states: paused swaps the dot for the play button and the mic glyph', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);
    await page.evaluate(() => {
      document
        .querySelector('#cyc-thread-pane .cyc-composer')!
        .toggleAttribute('data-cyc-recording', true);
      // The review (was "paused") phase is owned data-state on the panel now:
      // `data-cyc-rec=review` drives the pill's show/hide variants, not an `is-rec-*` class.
      (document.querySelector('#cyc-thread-pane .cyc-rec-panel') as HTMLElement).dataset.cycRec =
        'review';
    });
    await page.waitForTimeout(260);
    const play = await css(page, '#cyc-thread-pane .cyc-rec-play', ['display', 'border-radius']);
    // Was `html body .cyc-rec-play` -- the 2.5rem (40px) 10px pill flips to flex.
    expect(play?.display).toBe('flex');
    expect(px(play?.__w)).toBeCloseTo(40, 0);
    expect(play?.['border-radius']).toBe('10px');

    const dot = await css(page, '#cyc-thread-pane .cyc-rec-dot', ['display']);
    expect(dot?.display).toBe('none');

    const pauseGlyph = await css(page, '#cyc-thread-pane .is-rec-pause', ['display']);
    const micGlyph = await css(page, '#cyc-thread-pane .is-rec-mic', ['display']);
    expect(pauseGlyph?.display).toBe('none');
    expect(micGlyph?.display).toBe('inline-flex');
  } finally {
    await eng.close();
  }
});

test('composer states: dragging files over the pane raises the drop target', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);
    // The overlay is always mounted (its visibility gates on `.cyc-drop-mounted`, which the
    
    // resting it is display:none but position:absolute (its `absolute!` beat the cascade).
    const resting = await css(page, '#cyc-thread-pane .cyc-drop-layer', ['position', 'display']);
    expect(resting?.position).toBe('absolute');
    expect(resting?.display).toBe('none');
    // Reveal it and confirm it lays out as the centred flex column overlay.
    await page.evaluate(() =>
      document.querySelector('#cyc-thread-pane .cyc-drop-layer')!.classList.add('cyc-drop-mounted')
    );
    const layer = await css(page, '#cyc-thread-pane .cyc-drop-layer', [
      'display',
      'flex-direction',
      'justify-content',
      'align-items'
    ]);
    expect(layer?.display).toBe('flex');
    expect(layer?.['flex-direction']).toBe('column');
    expect(layer?.['justify-content']).toBe('center');
    expect(layer?.['align-items']).toBe('center');
  } finally {
    await eng.close();
  }
});

test('composer states: a staged file paints its chip and 1.5rem remove cross', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);
    // Real trigger: hand the hidden picker a file, exercising the stage path.
    await page
      .locator('#cyc-thread-pane .cyc-composer input[type=file]')
      .first()
      .setInputFiles({name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hi')});
    await page.waitForSelector('#cyc-thread-pane .cyc-attach-chip');
    const chip = await css(page, '#cyc-thread-pane .cyc-attach-chip', ['border-radius']);
    // The chip keeps its rounded corner; its remove cross is 1.5rem (24px at rem 16).
    expect(px(chip?.['border-radius'])).toBeGreaterThan(0);
    const remove = await css(page, '#cyc-thread-pane .cyc-attach-chip .cyc-attach-remove', []);
    expect(px(remove?.__w)).toBeCloseTo(24, 0);
    expect(px(remove?.__h)).toBeCloseTo(24, 0);
  } finally {
    await eng.close();
  }
});

test('composer states: phone floor + attach lead margin, gone at laptop', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port, 390, 844);
    const rowsPhone = await css(page, '#cyc-thread-pane .cyc-composer-rows', ['padding-bottom']);
    const attachPhone = await css(page, '#cyc-thread-pane .cyc-attach-btn', [
      'margin-inline-start'
    ]);
    const composerPhone = await css(page, '#cyc-thread-pane .cyc-composer', ['background-color']);
    // Was the `@media (max-width:600px)` floor/lead/background, now `max-tab:`.
    expect(px(rowsPhone?.['padding-bottom'])).toBeGreaterThan(20); // 1.5rem floor
    expect(px(attachPhone?.['margin-inline-start'])).toBeCloseTo(10, 0); // 0.625rem
    expect(composerPhone?.['background-color']).not.toBe('rgba(0, 0, 0, 0)');

    await page.setViewportSize({width: 1280, height: 800});
    await page.waitForTimeout(200);
    const rowsWide = await css(page, '#cyc-thread-pane .cyc-composer-rows', ['padding-bottom']);
    const attachWide = await css(page, '#cyc-thread-pane .cyc-attach-btn', ['margin-inline-start']);
    expect(px(rowsWide?.['padding-bottom'])).toBeCloseTo(0, 0);
    expect(px(attachWide?.['margin-inline-start'])).toBeCloseTo(0, 0);
  } finally {
    await eng.close();
  }
});

test('composer states: the recording panel surface tracks the theme surface var live', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await openComposer(page, eng.port);
    
    // theme system (preferences.applyCycTheme) rewrites `--cyc-surface` inline on the
    // root on every day<->night switch. Drive that same var and confirm the panel repaints.
    await page.evaluate(() =>
      document
        .querySelector('#cyc-thread-pane .cyc-composer')!
        .toggleAttribute('data-cyc-recording', true)
    );
    await page.waitForTimeout(260);
    const surface = () =>
      page.evaluate(
        () =>
          getComputedStyle(document.querySelector('#cyc-thread-pane .cyc-rec-panel')!)
            .backgroundColor
      );
    const day = await surface();
    expect(day).toBe('rgb(255, 255, 255)'); // day surface #ffffff
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--cyc-surface', '#17171a')
    );
    await page.waitForTimeout(60);
    expect(await surface()).toBe('rgb(23, 23, 26)'); // night surface #17171a
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--cyc-surface', '#ffffff')
    );
    await page.waitForTimeout(60);
    expect(await surface()).toBe(day);
  } finally {
    await eng.close();
  }
});
