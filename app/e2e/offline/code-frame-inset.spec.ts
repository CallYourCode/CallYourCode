import {test, expect, type Page} from '@playwright/test';
import {bootIsolated, openFixtureChat} from './rig';

// A FENCED CODE BLOCK KEEPS A SIDE GAP INSIDE THE MESSAGE.
//
// Owner's screenshots + voice note (2026-09-02, "we just need some gap on the
// sides"): a checklist rendered in a ``` fence ran EDGE-TO-EDGE. On phone a
// received bubble sits against the screen edge, and the code frame filled the
// message-text box border-to-border, so its border reached the screen edges with
// no side gap while the prose above and below it stayed inset. The fix gives the
// chat code frame the same horizontal inset as the surrounding message text
// (chat.css `.cyc-message .cyc-code-frame { margin-inline }`), so it sits within
// the conversation column with a clear gap on both inline sides.
//
// The contract this pins: rendered by the real renderMessages (testhooks) into
// the real chat pane, the `.cyc-code-frame`'s inline-start and inline-end edges
// are both strictly inside its containing `.cyc-message-text` box, so it can
// never regress back to edge-to-edge. Checked on phone, LTR and RTL.
// grep token: `code frame inset`.

const T = 1_700_000_000_000;
const CODE =
  'Here is the checklist you asked for:\n\n' +
  '```\n- [ ] one\n- [ ] two really long line here to see width\n- [ ] three\n```\n\n' +
  'Let me know if that works for you.';

// A visible, deliberate gap: the fix insets by 0.625rem (10px). Anything at or
// below a hairline would read as edge-to-edge, so require a clear multi-px gap
// on each inline side without hard-coding the exact margin.
const MIN_SIDE_GAP = 6;

type Edges = {left: number; right: number};

async function measure(page: Page, dir: 'ltr' | 'rtl'): Promise<{text: Edges; frame: Edges}> {
  return page.evaluate(
    async ({dir, T, CODE}) => {
      document.documentElement.dir = dir;
      const pane = document.querySelector<HTMLElement>('#cyc-thread-pane')!;
      const inner = pane.querySelector<HTMLElement>('.cyc-message-list-inner')!;
      const render = (window as unknown as {__cycRenderMessages: (...a: unknown[]) => void})
        .__cycRenderMessages;
      render(
        inner,
        [{id: 1, ts: T, status: 'delivered', role: 'claude', kind: 'text', text: CODE}],
        undefined,
        undefined,
        () => '',
        () => {}
      );
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const edges = (sel: string): {left: number; right: number} => {
        const el = pane.querySelector(`[data-mid="1"] ${sel}`);
        if (!el) throw new Error(`code frame inset: no ${sel}`);
        const r = el.getBoundingClientRect();
        return {left: Math.round(r.left * 100) / 100, right: Math.round(r.right * 100) / 100};
      };
      return {text: edges('.cyc-message-text'), frame: edges('.cyc-code-frame')};
    },
    {dir, T, CODE}
  );
}

for (const dir of ['ltr', 'rtl'] as const) {
  test(`code frame inset: phone 390x844, ${dir} side gap`, async ({page}) => {
    await bootIsolated(page, 390, 844);
    await openFixtureChat(page);
    const {text, frame} = await measure(page, dir);
    // The frame's near (start) and far (end) inline edges both sit inside the
    // message-text box, so the code block has a real gap on both sides.
    const startGap = dir === 'rtl' ? text.right - frame.right : frame.left - text.left;
    const endGap = dir === 'rtl' ? frame.left - text.left : text.right - frame.right;
    const tag = `${dir}: frame ${JSON.stringify(frame)} vs message-text ${JSON.stringify(text)}`;
    expect(startGap, `${tag}: inline-start gap`).toBeGreaterThanOrEqual(MIN_SIDE_GAP);
    expect(endGap, `${tag}: inline-end gap`).toBeGreaterThanOrEqual(MIN_SIDE_GAP);
  });
}
