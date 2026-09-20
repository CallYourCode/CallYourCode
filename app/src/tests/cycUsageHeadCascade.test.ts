import {afterAll, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type Page} from 'playwright';

/* THE USAGE-CARD HEAD: the app's freshness-status overlay must not transparently
 * overprint the engine frame's account email (#usagehead).
 *
 * The email lives inside the engine-composed no-JS iframe (.uc-head / .uc-who,
 * engine/agent-engine/src/plugins/usage-card/index.ts) and the freshness status
 * is APP chrome floated OVER that frame (whenEl in
 * src/components/pluginCard.ts). Because the two live on opposite sides of the
 * sandboxed-iframe seam, a real (sandbox="") card frame is cross-origin and its
 * contents are unmeasurable from the app. So this harness rebuilds the SAME
 * geometry with a same-origin srcdoc iframe: the app overlay (whenEl + refresh)
 * positioned exactly as pluginCard.ts positions them, over an iframe whose head
 * carries the engine's .uc-head reservation and .uc-who ellipsis.
 *
 * The revised contract has two states (see both files' cross-ref comments):
 *  - COMMON short status ("Nm ago"): the frame reserves only a SHORT zone
 *    (.uc-head padding-right:5.5rem), so the email shows nearly full and clears
 *    the short overlay with a gap -- no overprint, and most of the email visible.
 *  - RARE long status ("59m ago (check throttled)"): it extends left past that
 *    short reservation over the email tail, so whenEl carries an OPAQUE plate
 *    chip (color-mix(... --cyc-text-muted 16% ... --cyc-surface), px-1) that
 *    CLEANLY COVERS the email rather than bleeding through it. The status stays
 *    fully readable (max-w-[12rem], not clipped).
 *
 * The numbers mirrored here (whenEl end-8 = right:2rem, max-w-[12rem], px-1 pad,
 * plate bg; refresh end-2 = right:0.5rem, 1.375rem; card px-2 = 0.5rem; engine
 * .uc-head padding-right:5.5rem) are the two files' own values; if either file's
 * reservation changes without the other, the assertions here fail.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_WOFF2 = resolve(HERE, '..', '..', 'public', 'assets', 'fonts', 'inter-latin.woff2');

// The longest freshness status freshnessLabel() can emit (limitsAge.ts:37):
// "<age> (check throttled)". 59m is the widest age before it rolls to hours.
const LONGEST_STATUS = '59m ago (check throttled)';
// The COMMON short status: the widest "Nm ago" form (59m ago ~3.06rem in Inter).
const SHORT_STATUS = '59m ago';
// A deliberately long account email, so uc-who ellipsizes at BOTH widths.
const LONG_EMAIL =
  'a.very.long.account.email.address.used.for.testing.overflow.behaviour@some-really-long-subdomain.corporate-domain-name.example.com';

// The card plate: color-mix over these tokens, mirrored from the app card element
// (bg-[color-mix(in_srgb,var(--cyc-text-muted)_16%,var(--cyc-surface))]) and the
// frame body (sandbox.ts cardBaseStyle). Light-theme token values (sandbox.ts).
const CYC_TEXT_MUTED = '#6b6b70';
const CYC_SURFACE = '#ffffff';
const PLATE = 'color-mix(in srgb, var(--cyc-text-muted) 16%, var(--cyc-surface))';

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

afterAll(async () => {
  await browser?.close();
});

// Inline Inter (the app's real card font) into both the parent doc and the
// srcdoc, so widths match production rather than a headless fallback face.
function interFace(): string {
  const b64 = readFileSync(FONT_WOFF2).toString('base64');
  const src = `src:url(data:font/woff2;base64,${b64}) format('woff2')`;
  return (
    `@font-face{font-family:'Inter';font-style:normal;font-weight:400;${src}}` +
    `@font-face{font-family:'Inter';font-style:normal;font-weight:500;${src}}`
  );
}

// The engine frame's head rules, mirrored from
// engine/agent-engine/src/plugins/usage-card/index.ts STYLE. box-sizing:border-box
// is essential: the 5.5rem reservation is padding INSIDE the frame width. The
// body carries the plate so the email sits on the same surface the chip matches.
function frameSrcdoc(email: string): string {
  const face = interFace();
  return (
    `<!doctype html><html><head><style>${face}` +
    `*,*::before,*::after{box-sizing:border-box}html,body{margin:0}` +
    `:root{--cyc-text-muted:${CYC_TEXT_MUTED};--cyc-surface:${CYC_SURFACE}}` +
    `body{font-family:'Inter';font-size:12px;line-height:1.35;background:${PLATE}}` +
    `.uc-head{display:flex;align-items:center;gap:6px;height:22px;padding-right:5.5rem}` +
    `.uc-who{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}` +
    `</style></head><body>` +
    `<div class="uc"><div class="uc-head"><span class="uc-who">${email}</span></div></div>` +
    `</body></html>`
  );
}

// One card, built exactly as pluginCard.ts lays it out horizontally: a px-2
// (0.5rem) plate card box, the refresh button at end-2 (right:0.5rem) sized
// 1.375rem, the whenEl status at end-8 (right:2rem) capped at max-w-[12rem] with
// an opaque plate chip + px-1, and the engine frame as a full-width same-origin
// srcdoc iframe in the body.
async function buildCard(cardWidthPx: number, status: string, email: string): Promise<Page> {
  const face = interFace();
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><style>${face}` +
    `:root{--cyc-text-muted:${CYC_TEXT_MUTED};--cyc-surface:${CYC_SURFACE}}` +
    `*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:'Inter'}` +
    // card: relative, px-2 (0.5rem) like .cyc-plugincard, plate background.
    `#card{position:relative;box-sizing:border-box;padding:0.375rem 0.5rem;width:${cardWidthPx}px;` +
    `background:${PLATE}}` +
    // refresh: !absolute !top-1.5 !end-2, 1.375rem square
    `#refresh{position:absolute;top:0.375rem;right:0.5rem;width:1.375rem;height:1.375rem}` +
    // whenEl: absolute top-1.5 end-8 max-w-[12rem] px-1, opaque plate chip, ellipsis
    `#when{position:absolute;top:0.375rem;right:2rem;max-width:12rem;padding:0 0.25rem;` +
    `border-radius:3px;background:${PLATE};overflow:hidden;` +
    `text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.375rem;` +
    `pointer-events:none}` +
    `#body{position:relative;margin-top:0}` +
    `#frame{display:block;width:100%;border:0;height:40px;background:transparent}` +
    `</style></head><body>` +
    `<div id="card"><button id="refresh"></button><span id="when">${status}</span>` +
    `<div id="body"><iframe id="frame" srcdoc="${frameSrcdoc(email).replace(/"/g, '&quot;')}"></iframe></div>` +
    `</div></body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setViewportSize({width: Math.max(cardWidthPx + 40, 420), height: 400});
  await page.setContent(doc, {waitUntil: 'load'});
  await page.evaluate(async () => {
    await (document as unknown as {fonts: {ready: Promise<unknown>}}).fonts.ready;
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    const inner = frame.contentDocument;
    if (inner) await (inner as unknown as {fonts: {ready: Promise<unknown>}}).fonts.ready;
  });
  return page;
}

// Measure, in ONE (parent) coordinate space: the status chip edges + computed
// background, the email's right edge and visible/scroll widths, and the card box.
const measure = (page: Page) =>
  page.evaluate(() => {
    const card = document.getElementById('card') as HTMLElement;
    const when = document.getElementById('when') as HTMLElement;
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    const inner = frame.contentDocument!;
    const who = inner.querySelector('.uc-who') as HTMLElement;
    const whoRect = who.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const whenRect = when.getBoundingClientRect();
    return {
      cardWidth: cardRect.width,
      statusLeft: whenRect.left,
      statusRight: whenRect.right,
      statusBg: getComputedStyle(when).backgroundColor,
      // uc-who rect is relative to the iframe; shift into parent coords.
      emailRight: frameRect.left + whoRect.right,
      emailWidth: whoRect.width,
      whoScrollWidth: who.scrollWidth,
      whoClientWidth: who.clientWidth,
      whenScrollWidth: when.scrollWidth,
      whenClientWidth: when.clientWidth
    };
  });

// A background-color is opaque enough to cover the email: not the transparent
// keyword and not a zero-alpha rgba. (color-mix resolves to an rgb() here.)
function isTransparent(bg: string): boolean {
  if (!bg || bg === 'transparent') return true;
  const m = bg.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parts = m[1].split(/[,/]/).map((s) => s.trim());
  if (parts.length >= 4) return Number(parts[3]) === 0;
  return false;
}

describe('usage-card head: the status overlay never transparently overprints the email', () => {
  // COMMON short status: the email keeps MOST of its width and still clears the
  // short overlay with a gap (no overprint). This is the everyday fresh state.
  test('short status ("59m ago") at phone (~374px): email nearly full, no overprint', async () => {
    const page = await buildCard(374, SHORT_STATUS, LONG_EMAIL);
    try {
      const m = await measure(page);
      // No overprint: the email's right edge clears the (short) status chip left.
      expect(
        m.emailRight,
        `email right (${m.emailRight}) must clear short status left (${m.statusLeft})`
      ).toBeLessThanOrEqual(m.statusLeft + 0.5);
      // The email keeps most of the card: with only the short 5.5rem reserved, the
      // visible email is well over 60% of the card width (measured ~72%).
      expect(
        m.emailWidth / m.cardWidth,
        `email visible ${m.emailWidth} of card ${m.cardWidth} must exceed 60%`
      ).toBeGreaterThan(0.6);
      // It is a genuine ellipsis (the long email did not simply fit).
      expect(m.whoScrollWidth, 'email must be ellipsized').toBeGreaterThan(m.whoClientWidth);
    } finally {
      await page.close();
    }
  });

  // RARE long status: it extends left over the email tail, but on an OPAQUE plate
  // chip -- so no transparent overprint -- and stays fully readable (not clipped).
  async function expectCleanCover(cardWidthPx: number, label: string) {
    const page = await buildCard(cardWidthPx, LONGEST_STATUS, LONG_EMAIL);
    try {
      const m = await measure(page);
      // NO TRANSPARENT OVERPRINT: the chip behind the status text is opaque, so
      // wherever the long status sits over the email it covers it cleanly.
      expect(
        isTransparent(m.statusBg),
        `${label}: status chip background (${m.statusBg}) must be opaque, not transparent`
      ).toBe(false);
      // The chip actually reaches over the email tail (its left is at/left of the
      // email's right edge), so there is no bare transparent strip between them.
      expect(
        m.statusLeft,
        `${label}: chip left (${m.statusLeft}) must reach over the email right (${m.emailRight})`
      ).toBeLessThanOrEqual(m.emailRight + 0.5);
      // The status is fully readable: capped at 12rem, it is NOT itself clipped.
      expect(m.whenScrollWidth, `${label}: status must not be clipped`).toBeLessThanOrEqual(
        m.whenClientWidth + 0.5
      );
    } finally {
      await page.close();
    }
  }

  test('long status ("check throttled") at phone (~374px): opaque chip covers, not clipped', async () => {
    await expectCleanCover(374, 'phone');
  });

  test('long status ("check throttled") at desktop (~884px): opaque chip covers, not clipped', async () => {
    await expectCleanCover(884, 'desktop');
  });
});
