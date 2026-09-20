import {test, expect, type Page} from '@playwright/test';
import {bootIsolated, openFixtureChat} from './rig';

// The timestamp stamp (copy, quote, time, ticks) sits at the bottom inline-end
// corner of every bubble kind, and never paints over the bubble's own content.
// Owner's phone screenshots (2026-09-02): a file card whose stamp was drawn over
// the "9 KB" size line, and text bubbles whose stamp trailed the text wherever
// the last line ended or wrapped to the left edge.
//
// Every case is rendered by the real renderMessages (testhooks) into the real
// chat pane at phone width, then measured with getBoundingClientRect / Range
// rects in the page. Tolerance is 1px (fractional layout).

const T = 1_700_000_000_000;
const PARA =
  'The stamp has to sit at the bottom right of the bubble no matter how the text wraps or where its last line ends';

type Case = {name: string; m: Record<string, unknown>};

const img = (id: string) => ({
  uploadId: id,
  name: `${id}.png`,
  mime: 'image/png',
  size: 10,
  path: `${id}.png`,
  image: true,
  width: 96,
  height: 64
});
const pdf = (id: string) => ({
  uploadId: id,
  name: `${id}.pdf`,
  mime: 'application/pdf',
  size: 2048,
  path: `${id}.pdf`,
  image: false
});

function cases(): Case[] {
  const out: Case[] = [];
  out.push({name: 'user single short line', m: {role: 'user', kind: 'text', text: 'ok'}});
  out.push({name: 'claude single short line', m: {role: 'claude', kind: 'text', text: 'Sure.'}});
  // Wrapped bodies whose last line ends at many different places: some leave
  // room for the stamp beside the last line, some do not (it then drops below).
  for (let n = 24; n <= 100; n += 4) {
    out.push({
      name: `claude wrapped ${n}`,
      m: {role: 'claude', kind: 'text', text: PARA.slice(0, n)}
    });
  }
  for (let n = 30; n <= 100; n += 10) {
    out.push({name: `user wrapped ${n}`, m: {role: 'user', kind: 'text', text: PARA.slice(0, n)}});
  }
  out.push({
    name: 'claude wrapped, short last line',
    m: {role: 'claude', kind: 'text', text: PARA + '\nok'}
  });
  out.push({
    name: 'claude wrapped, long last line',
    m: {role: 'claude', kind: 'text', text: 'Here:\n' + PARA}
  });
  out.push({
    name: 'claude file card (huntlist.html, 9 KB)',
    m: {
      role: 'claude',
      kind: 'text',
      text: 'huntlist.html',
      file: {docId: 'd1', name: 'huntlist.html', fileKind: 'html', size: 9216}
    }
  });
  out.push({
    name: 'user upload card, no caption',
    m: {role: 'user', kind: 'text', text: '', upload: pdf('u1')}
  });
  out.push({
    name: 'claude download card (binary)',
    m: {
      role: 'claude',
      kind: 'text',
      text: 'log.bin',
      file: {docId: 'd2', name: 'log.bin', fileKind: 'binary', size: 5000}
    }
  });
  out.push({
    name: 'claude file card with caption',
    m: {
      role: 'claude',
      kind: 'text',
      text: 'here is the list you asked for, sorted by score',
      file: {docId: 'd3', name: 'huntlist.html', fileKind: 'html', size: 9216}
    }
  });
  out.push({
    name: 'user upload card with caption',
    m: {role: 'user', kind: 'text', text: 'the notes', upload: pdf('u2')}
  });
  out.push({
    name: 'user photo with caption',
    m: {role: 'user', kind: 'text', text: 'a caption for the photo', upload: img('p1')}
  });
  out.push({
    name: 'user photo, media only',
    m: {role: 'user', kind: 'text', text: '', upload: img('p2')}
  });
  out.push({
    name: 'user album with caption',
    m: {role: 'user', kind: 'text', text: 'look at these two', uploads: [img('a1'), img('a2')]}
  });
  out.push({
    name: 'user album, no caption',
    m: {role: 'user', kind: 'text', text: '', uploads: [img('b1'), img('b2')]}
  });
  out.push({
    name: 'user voice note',
    m: {role: 'user', kind: 'voice', text: 'said a thing into the phone', durationS: 3}
  });
  out.push({
    name: 'user reply-quoted message',
    m: {
      role: 'user',
      kind: 'text',
      text: 'yes, that one',
      replyTo: {ts: T - 60_000, role: 'claude', title: 'Claude', text: 'which file did you mean?'}
    }
  });
  return out;
}

type Measured = {
  name: string;
  placement: 'beside' | 'below' | 'row';
  problems: string[];
};

async function measure(page: Page, dir: 'ltr' | 'rtl'): Promise<Measured[]> {
  const list = cases();
  const messages = list.map((c, i) => ({id: i + 1, ts: T + i * 1000, status: 'delivered', ...c.m}));
  return page.evaluate(
    async ({messages, names, dir}) => {
      document.documentElement.dir = dir;
      const inner = document.querySelector<HTMLElement>(
        '#cyc-thread-pane .cyc-message-list-inner'
      )!;
      const render = (window as any).__cycRenderMessages as (
        inner: HTMLElement,
        messages: unknown[],
        firstUnreadId?: number,
        events?: unknown[],
        uploadUrl?: (id: string) => string,
        onOpenFile?: () => void
      ) => void;
      render(
        inner,
        messages,
        undefined,
        undefined,
        () => '',
        () => {}
      );
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          left: r.left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth),
          right: r.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth),
          bottom: r.bottom - parseFloat(s.paddingBottom) - parseFloat(s.borderBottomWidth)
        };
      };
      const overlaps = (a: DOMRect, b: DOMRect) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

      const out: {name: string; placement: 'beside' | 'below' | 'row'; problems: string[]}[] = [];
      const nodes = [...inner.querySelectorAll<HTMLElement>('[data-mid]')];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const problems: string[] = [];
        const node = nodes.find((n) => n.dataset.mid === String(i + 1));
        if (!node) {
          out.push({name, placement: 'row', problems: ['bubble not rendered']});
          continue;
        }
        const stamps = node.querySelectorAll<HTMLElement>('.cyc-stamp');
        if (stamps.length !== 1) {
          out.push({name, placement: 'row', problems: [`${stamps.length} stamps`]});
          continue;
        }
        const stamp = stamps[0];
        const sr = stamp.getBoundingClientRect();
        const body = node.querySelector<HTMLElement>('.cyc-message-text')!;
        const isCard = stamp.classList.contains('cyc-stamp-foot') || !!stamp.closest('.cyc-doc');
        const host = isCard ? stamp.closest<HTMLElement>('.cyc-doc')! : body;
        const hb = box(host);

        // Ink: every text run outside the stamp, plus the boxes that carry
        // non-text content (icons, media, players, buttons).
        const ink: {what: string; r: DOMRect}[] = [];
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          if (!t.textContent?.trim()) continue;
          if ((t.parentElement as Element).closest('.cyc-stamp')) continue;
          const range = document.createRange();
          range.selectNodeContents(t);
          for (const r of range.getClientRects()) {
            if (r.width > 0 && r.height > 0) ink.push({what: JSON.stringify(t.textContent), r});
          }
        }
        for (const sel of [
          '.cyc-doc-ico',
          '.cyc-media-box',
          '.cyc-multipart-album',
          '.cyc-clip',
          '.cyc-download-btn',
          '.cyc-msg-play',
          '.cyc-reply'
        ]) {
          for (const el of node.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) ink.push({what: sel, r});
          }
        }

        // Inline-end edge of the host content box.
        const endEdge = dir === 'rtl' ? hb.left : hb.right;
        const stampEnd = dir === 'rtl' ? sr.left : sr.right;
        if (Math.abs(stampEnd - endEdge) > 1) {
          problems.push(
            `inline-end edge off by ${(stampEnd - endEdge).toFixed(2)}px (stamp ${stampEnd.toFixed(2)}, host ${endEdge.toFixed(2)})`
          );
        }

        // Bottom: the host's content bottom; for a card, the size line's bottom.
        let placement: 'beside' | 'below' | 'row' = 'row';
        let bottomRef = hb.bottom;
        if (isCard) {
          const size = node.querySelector('.cyc-doc-size')!.getBoundingClientRect();
          bottomRef = size.bottom;
        } else {
          const lines = ink.filter((k) => k.what.startsWith('"'));
          // Viewport coordinates: rows the pinned list has scrolled above the
          // top have negative bottoms, so the seed must be -Infinity, not -1.
          const lastLine = lines.reduce(
            (a, k) => (k.r.bottom > (a?.bottom ?? -Infinity) ? k.r : a),
            null as DOMRect | null
          );
          placement = lastLine && sr.top < lastLine.bottom - 2 ? 'beside' : 'below';
        }
        if (Math.abs(sr.bottom - bottomRef) > 1) {
          problems.push(
            `bottom off by ${(sr.bottom - bottomRef).toFixed(2)}px (stamp ${sr.bottom.toFixed(2)}, ref ${bottomRef.toFixed(2)})`
          );
        }
        for (const k of ink) {
          if (overlaps(sr, k.r)) problems.push(`overlaps ${k.what}`);
        }
        // The stamp must also stay inside the bubble's body.
        const bb = box(body);
        if (sr.bottom > bb.bottom + 1) problems.push('stamp hangs below the bubble body');
        out.push({name, placement, problems});
      }
      document.documentElement.dir = 'ltr';
      return out;
    },
    {messages, names: list.map((c) => c.name), dir}
  );
}

function report(rows: Measured[]): string[] {
  return rows.filter((r) => r.problems.length).map((r) => `${r.name}: ${r.problems.join('; ')}`);
}

test.describe('stamp geometry: bottom inline-end of every bubble kind', () => {
  test.beforeEach(async ({page}) => {
    await bootIsolated(page, 390, 844);
    await openFixtureChat(page);
  });

  test('ltr: stamp at the bottom right, never over the content', async ({page}) => {
    const rows = await measure(page, 'ltr');
    expect(rows.length).toBe(cases().length);
    expect(report(rows)).toEqual([]);
    // The wrapped set must exercise both float paths.
    const wrapped = rows.filter((r) => r.name.includes('wrapped'));
    expect(
      wrapped.some((r) => r.placement === 'beside'),
      'no wrapped case put the stamp beside the last line'
    ).toBe(true);
    expect(
      wrapped.some((r) => r.placement === 'below'),
      'no wrapped case dropped the stamp below the last line'
    ).toBe(true);
    // A one-word last line always leaves room beside it. (Which long lines drop
    // the stamp depends on the font, so that side is proven by the stepped set.)
    expect(rows.find((r) => r.name === 'claude wrapped, short last line')!.placement).toBe(
      'beside'
    );
  });

  test('rtl: stamp at the bottom left (inline end), never over the content', async ({page}) => {
    const rows = await measure(page, 'rtl');
    expect(rows.length).toBe(cases().length);
    expect(report(rows)).toEqual([]);
  });
});
