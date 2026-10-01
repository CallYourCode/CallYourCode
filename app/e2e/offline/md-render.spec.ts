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
//
// The contract this pins: md-render.fixture.md (every element) opened through
// the real openFileViewer (testhooks), on laptop and phone, checked by computed
// style: code blocks are monospace, scroll inside themselves and never widen the
// page; blockquotes carry a left rule, muted text and real nested blocks;
// headings step down in size from an H1 well above body text; bullet lists keep
// markers and indent; the wide table scrolls in its own container.
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
    const box = md.querySelector<HTMLElement>('input[type="checkbox"]');
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
      checkboxWidth: box ? box.getBoundingClientRect().width : 0,
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
  expect.soft(p.checkboxWidth, 'task boxes are visible').toBeGreaterThan(8);

  expect.soft(p.wrapOverflowX).toBe('auto');
  if (phone) expect.soft(p.tableScrolls, 'the wide table scrolls in its own container').toBe(true);
  expect.soft(p.pageOverflow, 'nothing widens the page').toBeLessThanOrEqual(0);

  for (const raw of ['*bold italic', '&amp;', '&copy;', '!an image', '> A nested', '- a list'])
    expect.soft(p.text, `no raw markdown/entity ${raw}`).not.toContain(raw);
}

for (const [name, w, hgt] of [
  ['laptop', 1440, 900],
  ['phone', 390, 844]
] as const) {
  test(`md render: every markdown block reads right in the file viewer (${name})`, async ({
    page
  }) => {
    await bootIsolated(page, w, hgt);
    await openFixture(page);
    expectReadable(await probe(page), name === 'phone');
    await evidenceShot(page, 'md-render', `${name}-day`);
  });
}
