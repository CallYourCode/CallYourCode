import {expect, test, type Page} from '@playwright/test';
import {bootEngines, evidenceShot} from './rig';
import {startPresentationEngine} from './presentationEngine';

// The agents-bar left column must never cross the rule into the next-agent pill.
//
// Bug (iPhone PWA, 2026-09-02): with a long running-task subtitle the left column
// ("3 agents running" + "<task> · 20s") did not truncate. The subtitle ran through
// the vertical rule and under the pill's label, and the age was clipped by the rule.
// Root cause: the content column had no `min-width: 0` and the line boxes were
// `overflow: visible`, so `text-overflow: ellipsis` never engaged and the nowrap
// text kept its full width.
//
// This spec drives the bar through 1, 2 and 3 running agents with a long (60+
// chars) and a short subtitle, at a phone and a laptop viewport, in LTR and RTL,
// with the next-agent pill present (a sibling chat carries unread), and proves
// mechanically at every state that:
//   * the subtitle box ends at or before the rule (the pill slot's inline-start edge);
//   * the age span is visible, unclipped and inside the left column;
//   * the task span truncates (long) or does not (short);
//   * the pill's button box does not intersect the left column, and its label is
//     not truncated (the pill keeps its natural width).

test.use({timezoneId: 'UTC', locale: 'en-US'});

// phone 393x852 (iPhone CSS px), laptop 1280x800.
const VIEWPORTS = [
  ['phone', 393, 852],
  ['laptop', 1280, 800]
] as const;

// Long: wider than the laptop left column (about 580px), so it truncates at both
// viewports. Short: fits beside the pi badge and the stop gutter on the phone.
const LONG_DESC =
  'DnD overlay, bottom button, date pill, and the agents bar overflow on phone; ' +
  'then the composer keyboard inset and the waveform width';
const SHORT_DESC = 'Nudge builder';
const SUBTITLES = [
  ['long', LONG_DESC],
  ['short', SHORT_DESC]
] as const;

const DIRS = ['ltr', 'rtl'] as const;

const REDUCE_MOTION = () => {
  const s = document.createElement('style');
  s.textContent =
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
    'transition-duration:0s!important;transition-delay:0s!important;' +
    'scroll-behavior:auto!important;caret-color:transparent!important}';
  document.documentElement.appendChild(s);
};

// `n` running agents. The bar shows the newest run (highest ts) as the subtitle;
// that one carries `desc`. From two agents up the shown run is a pi run, so the
// stop button and its end gutter are in play as well.
function runningAgents(n: number, desc: string) {
  const now = Date.now();
  return Array.from({length: n}, (_, i) => ({
    toolUseId: `overflow-${i}`,
    agentId: `overflow-a${i}`,
    ts: now - 20_000 - i * 60_000,
    desc: i === 0 ? desc : `filler agent ${i}`,
    endedTs: null,
    tokens: null,
    ...(i === 0 && n >= 2 ? {source: 'pi', model: 'opus'} : {})
  }));
}

async function boot(page: Page, port: number, w: number, h: number) {
  await page.addInitScript(REDUCE_MOTION);
  await bootEngines(page, [port], {size: {width: w, height: h}});
  await page.waitForSelector('#cyc-left-pane');
}

// Open "Metrics Dashboard" (unread 2): it clears on open, leaving "Auth Gateway"
// (unread 1) as the one waiting chat, so the next-agent pill shows and the slot
// is in its non-bare state with the inline-start rule.
async function openChatWithPill(page: Page) {
  await page.locator('#cyc-left-pane .cyc-session-entry', {hasText: 'Metrics Dashboard'}).first().click();
  await page.waitForSelector('#cyc-thread-pane .cyc-message-list-scroll', {timeout: 15_000});
  await page.waitForFunction(() => !!(window as {__cycAgentsBar?: unknown}).__cycAgentsBar, null, {
    timeout: 15_000
  });
}

type Rect = {left: number; right: number; top: number; bottom: number; width: number; height: number};

async function readState(page: Page) {
  return page.evaluate(() => {
    const q = (sel: string) => document.querySelector<HTMLElement>(`#cyc-thread-pane ${sel}`);
    const rect = (el: HTMLElement | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height};
    };
    const overflowing = (el: HTMLElement | null) => (el ? el.scrollWidth > el.clientWidth + 1 : null);
    const bar = q('.cyc-agents-bar');
    const wrap = q('.cyc-agents-strip-wrap');
    const subtitle = q('.cyc-agents-strip-subtitle');
    const task = q('.cyc-agents-task');
    const age = q('.cyc-agents-age');
    const slot = q('.cyc-agents-slot');
    const btn = q('.cyc-jump-next');
    const label = q('.cyc-jump-label');
    return {
      dir: getComputedStyle(document.documentElement).direction,
      barOff: !bar || bar.classList.contains('cyc-off'),
      slotOff: !slot || slot.classList.contains('cyc-off'),
      bar: rect(bar),
      wrap: rect(wrap),
      subtitle: rect(subtitle),
      subtitleText: subtitle?.textContent ?? '',
      task: rect(task),
      taskOverflowing: overflowing(task),
      age: rect(age),
      ageText: age?.textContent ?? '',
      ageOverflowing: overflowing(age),
      slot: rect(slot),
      btn: rect(btn),
      label: rect(label),
      labelText: label?.textContent ?? '',
      labelOverflowing: overflowing(label)
    };
  });
}

// Standard AABB overlap with an epsilon so shared/adjacent edges do not count.
function intersects(a: Rect, b: Rect, eps = 1): boolean {
  return a.left < b.right - eps && a.right > b.left + eps && a.top < b.bottom - eps && a.bottom > b.top + eps;
}

function inside(inner: Rect, outer: Rect, eps = 0.5): boolean {
  return (
    inner.left >= outer.left - eps &&
    inner.right <= outer.right + eps &&
    inner.top >= outer.top - eps &&
    inner.bottom <= outer.bottom + eps
  );
}

for (const [width, w, h] of VIEWPORTS) {
  for (const [length, desc] of SUBTITLES) {
    test(`agents-bar overflow ${width}/${length}: left column truncates before the rule, age stays, pill keeps its width`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      const eng = await startPresentationEngine();
      try {
        await boot(page, eng.port, w, h);
        await openChatWithPill(page);

        for (const dir of DIRS) {
          await page.evaluate((d) => {
            document.documentElement.dir = d;
          }, dir);

          for (const n of [1, 2, 3]) {
            await page.evaluate((runs) => {
              (window as {__cycAgentsBar: {update: (r: unknown[]) => void}}).__cycAgentsBar.update(runs);
            }, runningAgents(n, desc));
            await page.waitForTimeout(150);

            const tag = `${width}/${length}/${dir}/${n} agents`;
            const s = await readState(page);
            if (n === 3) await evidenceShot(page, 'agents-bar', `overflow-${width}-${length}-${dir}`);

            expect(s.dir, tag).toBe(dir);
            expect(s.barOff, `${tag}: bar hidden`).toBe(false);
            expect(s.slotOff, `${tag}: pill slot hidden (no waiting chat?)`).toBe(false);
            for (const [name, r] of Object.entries({
              wrap: s.wrap,
              subtitle: s.subtitle,
              task: s.task,
              age: s.age,
              slot: s.slot,
              btn: s.btn,
              label: s.label
            })) {
              expect(r, `${tag}: ${name} has no box`).not.toBeNull();
            }
            const wrap = s.wrap!;
            const subtitle = s.subtitle!;
            const task = s.task!;
            const age = s.age!;
            const slot = s.slot!;
            const btn = s.btn!;
            const label = s.label!;

            // The subtitle carries the task and the age, in that order.
            expect(s.subtitleText, tag).toContain(desc);
            expect(s.ageText, tag).toMatch(/^ · \d+[smh]/);
            expect(s.subtitleText.endsWith(s.ageText), `${tag}: age is not the tail of the subtitle`).toBe(true);

            // The rule is the slot's inline-start edge. The subtitle box ends at or
            // before it, never across.
            const ruleX = dir === 'ltr' ? slot.left : slot.right;
            if (dir === 'ltr') {
              expect(subtitle.right, `${tag}: subtitle crosses the rule (right ${subtitle.right} > rule ${ruleX})`).toBeLessThanOrEqual(ruleX + 0.5);
              expect(wrap.right, `${tag}: left column crosses the rule`).toBeLessThanOrEqual(ruleX + 0.5);
            } else {
              expect(subtitle.left, `${tag}: subtitle crosses the rule (left ${subtitle.left} < rule ${ruleX})`).toBeGreaterThanOrEqual(ruleX - 0.5);
              expect(wrap.left, `${tag}: left column crosses the rule`).toBeGreaterThanOrEqual(ruleX - 0.5);
            }

            // The age is visible, unclipped, and inside both the subtitle line and
            // the left column.
            expect(age.width, `${tag}: age span has no width`).toBeGreaterThan(0);
            expect(s.ageOverflowing, `${tag}: age span is clipped`).toBe(false);
            expect(inside(age, subtitle), `${tag}: age ${JSON.stringify(age)} outside subtitle ${JSON.stringify(subtitle)}`).toBe(true);
            expect(inside(age, wrap), `${tag}: age ${JSON.stringify(age)} outside left column ${JSON.stringify(wrap)}`).toBe(true);
            // The age sits after the task along the inline axis.
            if (dir === 'ltr') expect(age.left, `${tag}: age not after the task`).toBeGreaterThanOrEqual(task.right - 0.5);
            else expect(age.right, `${tag}: age not after the task`).toBeLessThanOrEqual(task.left + 0.5);

            // Long: the task truncates (ellipsis engaged). Short: it does not.
            expect(inside(task, subtitle), `${tag}: task box outside subtitle`).toBe(true);
            expect(s.taskOverflowing, `${tag}: task ${length === 'long' ? 'should' : 'should not'} truncate`).toBe(
              length === 'long'
            );

            // The pill keeps its natural width: its button box never meets the left
            // column and its label is not truncated.
            expect(intersects(btn, wrap), `${tag}: pill button ${JSON.stringify(btn)} intersects left column ${JSON.stringify(wrap)}`).toBe(false);
            expect(intersects(btn, subtitle), `${tag}: pill button intersects the subtitle`).toBe(false);
            expect(s.labelText, tag).toBe('Auth Gateway');
            expect(s.labelOverflowing, `${tag}: pill label truncated`).toBe(false);
            expect(inside(btn, slot), `${tag}: pill button outside its slot`).toBe(true);
          }
        }
      } finally {
        await page.evaluate(() => {
          document.documentElement.dir = '';
        }).catch(() => {});
        await eng.close();
      }
    });
  }
}
