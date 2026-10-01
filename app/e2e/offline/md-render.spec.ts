import {test, expect, type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {bootIsolated, evidenceShot} from './rig';

// THE MARKDOWN FILE VIEWER RENDERS EVERY BLOCK READABLY.
//
// Owner's report (laptop, 2026-10-01, "in the md view it doesn't render code
// blocks or block quotes or other stuff well"): in the full-screen viewer for a
// shown thread.md the `# title` H1 was body-size text and `---` a near-invisible
// line. Root causes: h1 had no size class; the un-layered chrome.css `h4` rule
// and reset.css `:where(ul)` reset beat the layered utilities (h4 bigger than h2,
// bullet lists with no markers or indent); --cyc-border-color all but vanishes on
// the viewer background; and the parser kept quotes inline-only (nested `>` and
// lists printed literally), had no indented code, left `***x***` asterisks,
// rendered `![alt](src)` as "!" plus a link and left HTML entities raw.
// Review follow-ups: the native task checkbox drew dark on the day page (index.html
// declares `color-scheme: dark`), `w-max` tables scrolled sideways on a laptop
// where they fit, and an indented second paragraph in a list item became code.
//
// The contract this pins: md-render.fixture.md (every element) opened through
// the real openFileViewer (testhooks), on laptop and phone, checked by computed
// style: code blocks are monospace, scroll inside themselves and never widen the
// page; blockquotes carry a left rule, muted text and real nested blocks;
// headings step down in size from an H1 well above body text; bullet lists keep
// markers and indent, and indented paragraphs stay in their item; task boxes,
// open and done, stand out from the page by day and by night; the wide table
// fits the laptop column and scrolls in its own container on a phone without
// squeezing its cells; a remote image is a link (REMOTE_IMAGES is off).
// grep token: `md render`.

const MD = readFileSync(resolve(__dirname, 'md-render.fixture.md'), 'utf8');

async function openFixture(page: Page): Promise<void> {
  await page.evaluate((content) => {
    (window as unknown as {__cycOpenFileViewer: (...a: unknown[]) => void}).__cycOpenFileViewer(
      {docId: 'md-render', name: 'thread.md', fileKind: 'markdown', size: content.length},
      undefined,
      '',
      undefined,
      async () => ({name: 'thread.md', fileKind: 'markdown', content})
    );
  }, MD);
  await page.waitForSelector('.cyc-file-viewer .cyc-md', {timeout: 10_000});
  await page.waitForTimeout(300);
}

type Probe = Awaited<ReturnType<typeof probe>>;

function probe(page: Page) {
  return page.evaluate(() => {
    const md = document.querySelector<HTMLElement>('.cyc-md')!;
    const scroll = document.querySelector<HTMLElement>('.cyc-fv-scroll')!;
    const px = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
    const code = md.querySelector<HTMLElement>('pre .cyc-src-body')!;
    const quote = md.querySelector<HTMLElement>(':scope > blockquote')!;
    const ul = md.querySelector<HTMLElement>(':scope > ul')!;
    const wrap = md.querySelector<HTMLElement>('.cyc-md-table-wrap')!;
    // The fixture's open task comes first, its done one second. Missing boxes
    // probe as zero so the soft checks below still name every failure.
    const [open, done] = [...md.querySelectorAll<HTMLElement>('.cyc-md-checkbox')];
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // The colour the box sits on: the nearest ancestor with an opaque background.
    let under = open?.parentElement ?? null;
    while (under && (rgb(getComputedStyle(under).backgroundColor)[3] ?? 1) === 0)
      under = under.parentElement;
    const page = getComputedStyle(under ?? document.body).backgroundColor;
    const openStyle = getComputedStyle(open ?? md);
    const doneFill = done ? getComputedStyle(done).backgroundColor : page;
    const cells = [...md.querySelectorAll<HTMLElement>('.cyc-md-table td')];
    return {
      body: px(md),
      headings: [1, 2, 3, 4, 5, 6].map((n) => px(md.querySelector('h' + n))),
      codeBlocks: md.querySelectorAll('pre.cyc-code-frame').length,
      codeFont: getComputedStyle(code).fontFamily,
      codeOverflowX: getComputedStyle(code).overflowX,
      codeScrolls: code.scrollWidth > code.clientWidth,
      preBackground: getComputedStyle(code.closest('pre')!).backgroundColor,
      quoteBorder: parseFloat(getComputedStyle(quote).borderInlineStartWidth),
      quoteColor: getComputedStyle(quote).color,
      bodyColor: getComputedStyle(md).color,
      quoteNested: !!quote.querySelector('blockquote') && !!quote.querySelector('ul li'),
      ulStyle: getComputedStyle(ul).listStyleType,
      ulIndent: parseFloat(getComputedStyle(ul).paddingInlineStart),
      wrapOverflowX: getComputedStyle(wrap).overflowX,
      tableScrolls: wrap.scrollWidth > wrap.clientWidth,
      checkboxWidth: open?.getBoundingClientRect().width ?? 0,
      openBorder: parseFloat(openStyle.borderTopWidth),
      openBorderOnPage: contrast(openStyle.borderTopColor, page),
      openBorderOnFill: contrast(openStyle.borderTopColor, openStyle.backgroundColor),
      doneFillOnPage: contrast(doneFill, page),
      doneTick: !!done?.querySelector('svg'),
      narrowestCell: Math.min(...cells.map((c) => c.getBoundingClientRect().width)),
      images: md.querySelectorAll('img').length,
      imageLink: md.querySelector('.cyc-md-image-link')?.textContent ?? '',
      itemParas: [...md.querySelectorAll('li > p')].map((el) => el.textContent ?? ''),
      pageOverflow: scroll.scrollWidth - scroll.clientWidth,
      text: md.innerText
    };
  });
}

// Soft, so a regression names every element that broke, not just the first.
function expectReadable(p: Probe, phone: boolean): void {
  expect.soft(p.headings[0], 'H1 must stand well above body text').toBeGreaterThan(p.body * 1.4);
  for (let i = 1; i < 6; i++)
    expect
      .soft(p.headings[i], `h${i + 1} must not outgrow h${i}`)
      .toBeLessThanOrEqual(p.headings[i - 1]);

  expect.soft(p.codeBlocks, 'two fenced blocks and one indented block').toBe(3);
  expect.soft(p.codeFont).toMatch(/mono/i);
  expect.soft(p.codeOverflowX).toBe('auto');
  expect.soft(p.codeScrolls, 'the long code line scrolls inside its block').toBe(true);
  expect.soft(p.preBackground, 'the code block has its own surface').not.toBe('rgba(0, 0, 0, 0)');

  expect.soft(p.quoteBorder).toBeGreaterThanOrEqual(2);
  expect.soft(p.quoteColor, 'quote text is muted').not.toBe(p.bodyColor);
  expect.soft(p.quoteNested, 'nested quote and list render as blocks').toBe(true);

  expect.soft(p.ulStyle).toBe('disc');
  expect.soft(p.ulIndent).toBeGreaterThan(10);
  expect
    .soft(p.itemParas, 'indented paragraphs stay in their list item')
    .toEqual([
      'Its second paragraph, indented under the item.',
      'Its third paragraph, still part of the item.'
    ]);

  expect.soft(p.checkboxWidth, 'task boxes are visible').toBeGreaterThan(8);
  expect.soft(p.openBorder, 'the open box has a border').toBeGreaterThanOrEqual(1);
  expect
    .soft(p.openBorderOnPage, 'the open box border stands out from the page')
    .toBeGreaterThan(3);
  expect.soft(p.openBorderOnFill, 'the open box is not a solid square').toBeGreaterThan(3);
  expect.soft(p.doneFillOnPage, 'the done box fill stands out').toBeGreaterThan(3);
  expect.soft(p.doneTick, 'the done box carries a tick').toBe(true);

  expect.soft(p.wrapOverflowX).toBe('auto');
  if (phone) {
    expect.soft(p.tableScrolls, 'the wide table scrolls in its own container').toBe(true);
    expect.soft(p.narrowestCell, 'cells keep a readable width').toBeGreaterThanOrEqual(115);
  } else expect.soft(p.tableScrolls, 'the table fits the laptop column').toBe(false);
  expect.soft(p.pageOverflow, 'nothing widens the page').toBeLessThanOrEqual(0);

  expect.soft(p.images, 'remote images are not fetched').toBe(0);
  expect.soft(p.imageLink, 'the image is a link named by its alt text').toBe('an image alt text');

  for (const raw of ['*bold italic', '&amp;', '&copy;', '!an image', '> A nested', '- a list'])
    expect.soft(p.text, `no raw markdown/entity ${raw}`).not.toContain(raw);
}

for (const theme of ['day', 'night'] as const) {
  for (const [name, w, hgt] of [
    ['laptop', 1440, 900],
    ['phone', 390, 844]
  ] as const) {
    test(`md render: every markdown block reads right in the file viewer (${name}, ${theme})`, async ({
      page
    }) => {
      await page.addInitScript((t) => localStorage.setItem('cyc-skin', t), theme);
      await bootIsolated(page, w, hgt);
      await openFixture(page);
      expectReadable(await probe(page), name === 'phone');
      await evidenceShot(page, 'md-render', `${name}-${theme}`);
    });
  }
}
