import {expect, test, type Page} from '@playwright/test';
import {bootEngines} from './rig';
import {startPresentationEngine} from './presentationEngine';

// DIAL WITH A TALL DRAFT (fix-dial-tall). The owner, laptop, mouse: with about
// 25 lines in the message box, clicking the Verbosity dial button showed
// nothing. The dial panel sits inside the composer pill, above the text line;
// the pill caps at --cyc-pill-max and the text line alone could fill that cap,
// so the panel (the only part allowed to shrink) was squeezed to 0 px. The
// contract: an open dial keeps its natural height and the text line yields
// (shrinks and scrolls); with a short draft the field is exactly as before.
// grep token: `dial tall`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const VIEWS = [
  {label: 'laptop', size: {width: 1440, height: 900}, touch: false},
  {label: 'half', size: {width: 720, height: 900}, touch: false},
  {label: 'phone', size: {width: 390, height: 844}, touch: true}
] as const;
type View = (typeof VIEWS)[number];

const RICH_ROW = 'Relay Server';
const INPUT = '#cyc-thread-pane .cyc-composer-input';
const PILL = '#cyc-thread-pane .cyc-composer-rows';
const DIAL_BTN = '#cyc-thread-pane .cyc-plugin-extra[aria-label="Verbosity"]';
const PANEL = '#cyc-thread-pane .cyc-replylevel-plugin';

// Nine paragraphs with blank lines between them and a '---' line, about the
// size of the owner's draft.
const TALL = [
  'what? which tabs under the hero? it was in the popup where people submit.',
  'the three big outcomes can also include finding what rivals are doing right.',
  'for each outcome we can list the tools that we cross out. finding people to promote it is also a good outcome. remember what you said about the small band, those are the people we are aiming at.',
  'other jobs can be included too, that makes sense.',
  'the scope is the whole site, all pages. I understand this is a big change, so we should agree on the principles first. the research you did and the conclusions were right. the site has good design but weak respect for its reader, and it is diluted with things that are a much smaller part of their money, time and head space.',
  'these tabs are too big. the top band can be its own category, and picking it should show a line saying they should consider buying the tools and hiring for this instead. they can still ask for the report.',
  'the hero product, I do not know if that is a real term, or the killer product, or the profitable one.',
  'we have no proof yet, but later we can add case studies as we do more reports. not yet though, because I want to make these reports first and reach out.',
  '---',
  'overall the suggestions were thin. the research step was good, but the changes to the site were half done. let us agree on principles, then you can update the copy.'
].join('\n\n');

async function openComposer(page: Page, port: number) {
  await bootEngines(page, [port]);
  await page.waitForSelector('#cyc-left-pane');
  const row = page.locator('.cyc-session-entry', {hasText: RICH_ROW}).first();
  // The phone opens on the list; wider views already show it beside the chat.
  if (await row.isVisible()) await row.click();
  await page.waitForSelector(DIAL_BTN, {state: 'visible'});
  await page.waitForTimeout(300);
}

async function typeDraft(page: Page, text: string) {
  await page.locator(INPUT).click();
  await page.keyboard.insertText(text);
  await page.waitForTimeout(300);
}

async function press(page: Page, view: View, sel: string) {
  if (view.touch) await page.locator(sel).tap();
  else await page.locator(sel).click();
  await page.waitForTimeout(300);
}

const geometry = (page: Page) =>
  page.evaluate(
    ({input, pill, panel}) => {
      const i = document.querySelector<HTMLElement>(input)!;
      const p = document.querySelector<HTMLElement>(pill)!;
      const d = document.querySelector<HTMLElement>(panel)!;
      const dr = d.getBoundingClientRect();
      return {
        inputH: i.getBoundingClientRect().height,
        inputScrolls: i.scrollHeight > i.clientHeight + 1,
        pillH: p.getBoundingClientRect().height,
        pillMax: parseFloat(getComputedStyle(p).maxHeight),
        panelH: dr.height,
        panelNatural: d.scrollHeight,
        panelTop: dr.top,
        panelBottom: dr.bottom,
        vh: window.innerHeight
      };
    },
    {input: INPUT, pill: PILL, panel: PANEL}
  );

for (const view of VIEWS) {
  test.describe(view.label, () => {
    test.use({viewport: view.size, hasTouch: view.touch, isMobile: view.touch});

    test(`dial tall (${view.label}): with a tall draft the open dial keeps its height and the text scrolls`, async ({
      page
    }) => {
      const eng = await startPresentationEngine({dials: true});
      try {
        await openComposer(page, eng.port);
        await typeDraft(page, TALL);
        const before = await geometry(page);
        expect(before.inputScrolls, 'the draft is not tall enough to fill the pill').toBe(true);

        await press(page, view, DIAL_BTN);
        const g = await geometry(page);
        expect(g.panelNatural, 'the dial panel has no content').toBeGreaterThan(40);
        expect(g.panelH, `the open dial is squeezed: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(
          g.panelNatural - 1
        );
        expect(g.panelTop).toBeGreaterThanOrEqual(0);
        expect(g.panelBottom).toBeLessThanOrEqual(g.vh);
        expect(g.pillH, 'the pill grew past its cap').toBeLessThanOrEqual(g.pillMax + 1);
        expect(g.inputH, 'the text line vanished').toBeGreaterThanOrEqual(40);
        expect(g.inputScrolls, 'the text line does not scroll').toBe(true);

        // Closing the dial gives the text line its full height back.
        await press(page, view, DIAL_BTN);
        expect((await geometry(page)).inputH).toBe(before.inputH);
      } finally {
        await eng.close();
      }
    });

    test(`dial tall (${view.label}): with a short draft opening the dial leaves the text line as it was`, async ({
      page
    }) => {
      const eng = await startPresentationEngine({dials: true});
      try {
        await openComposer(page, eng.port);
        await typeDraft(page, 'one line\ntwo lines\nthree lines');
        const before = await geometry(page);
        await press(page, view, DIAL_BTN);
        const g = await geometry(page);
        expect(g.inputH).toBe(before.inputH);
        expect(g.inputScrolls).toBe(false);
        expect(g.panelH).toBeGreaterThanOrEqual(g.panelNatural - 1);
      } finally {
        await eng.close();
      }
    });
  });
}
