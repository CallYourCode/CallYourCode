import {test, expect, type Page} from '@playwright/test';
import {startTransferEngine, type TransferEngine} from '../offline/transferEngine';
import {bootVoice, holdMic} from './voiceKit';

// The lock chip above the mic while a press-and-hold records. It floats over
// the chat, so it carries the theme surface like the other composer controls;
// a see-through chip let the chat show through it (iPhone, 2026-10-03).
//
// grep token: `lock chip surface`.

async function chipPaint(page: Page) {
  return page.evaluate(() => {
    const chip = document.querySelector('.cyc-rec-lock') as HTMLElement;
    const probe = document.createElement('div');
    probe.style.background = 'var(--cyc-surface)';
    document.body.append(probe);
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const r = chip.getBoundingClientRect();
    return {
      background: getComputedStyle(chip).backgroundColor,
      surface,
      visible: r.width > 0 && r.height > 0,
      rect: {x: r.x, y: r.y, width: r.width, height: r.height}
    };
  });
}

for (const skin of ['day', 'night'] as const) {
  test(`lock chip surface: the chip over the chat is painted with the ${skin} surface`, async ({
    page,
    browserName
  }) => {
    const engine: TransferEngine = await startTransferEngine({});
    try {
      await bootVoice(page, engine.port, {skin});
      let paint: Awaited<ReturnType<typeof chipPaint>> | null = null;
      await holdMic(page, async () => {
        await page.waitForTimeout(800);
        paint = await chipPaint(page);
        const dir = process.env.VR_SHOTS;
        if (dir) {
          const vp = page.viewportSize()!;
          await page.screenshot({
            path: `${dir}/lock-chip-${browserName}-${skin}.png`,
            clip: {x: vp.width - 170, y: vp.height - 230, width: 170, height: 230}
          });
        }
      });
      const p = paint!;
      console.log(`[lock chip surface] ${browserName} ${skin}: ${JSON.stringify(p)}`);
      expect(p.visible, 'the chip shows while holding').toBe(true);
      expect(p.background, 'the chip is painted with the theme surface').toBe(p.surface);
    } finally {
      await engine.close();
    }
  });
}
