import {beforeEach, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import type {CycMessage} from '../types';
import {
  textMessage,
  photoMessage,
  flowStamp,
  footStamp,
  docFootRow
} from '../features/chat/messages/messageContent';
import {audioMessage} from '../features/chat/messages/audioMessages';
import {attachmentMessage, uploadMessage} from '../features/chat/messages/attachmentMessages';
import {snippetMessage, fileMessage, downloadMessage} from '../features/chat/messages/fileMessages';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const MESSAGES = resolve(SRC, 'features/chat/messages');

const msg = (over: Partial<CycMessage>): CycMessage =>
  ({
    id: 1,
    role: 'user',
    kind: 'text',
    text: 'hello there',
    ts: 1700000000000,
    ...over
  }) as CycMessage;

const img = (id: string) =>
  ({
    uploadId: id,
    name: `${id}.png`,
    mime: 'image/png',
    size: 10,
    path: `${id}.png`,
    image: true,
    width: 96,
    height: 64
  }) as NonNullable<CycMessage['upload']>;
const doc = (id: string) =>
  ({
    uploadId: id,
    name: `${id}.pdf`,
    mime: 'application/pdf',
    size: 10,
    path: `${id}.pdf`,
    image: false
  }) as NonNullable<CycMessage['upload']>;

// Message renderers under test.
const PRODUCERS: Record<string, (first: boolean, last: boolean) => HTMLElement> = {
  text: (f, l) => textMessage(msg({text: 'hi'}), f, l),
  'photo-caption': (f, l) => photoMessage(msg({text: 'a caption'}), f, l, 'http://x/p.png', 'alt'),
  'photo-media-only': (f, l) => photoMessage(msg({text: 'alt'}), f, l, 'http://x/p.png', 'alt'),
  'doc-lone': (f, l) =>
    fileMessage(
      msg({text: 'notes.txt', file: {docId: 'd', name: 'notes.txt', fileKind: 'text', size: 12}}),
      f,
      l
    ),
  'doc-caption': (f, l) =>
    fileMessage(
      msg({text: 'here it is', file: {docId: 'd', name: 'notes.txt', fileKind: 'text', size: 12}}),
      f,
      l
    ),
  'doc-upload': (f, l) =>
    uploadMessage(msg({text: 'notes.pdf', upload: doc('u2')}), f, l, 'http://x/u2.pdf'),
  'doc-download': (f, l) =>
    downloadMessage(
      msg({text: 'log.bin', file: {docId: 'd', name: 'log.bin', fileKind: 'binary', size: 5}}),
      f,
      l,
      () => {}
    ),
  album: (f, l) =>
    attachmentMessage(
      msg({text: '', uploads: [img('a'), img('b')]}),
      f,
      l,
      (u) => `http://x/${u!.uploadId}`
    ),
  snippet: (f, l) =>
    snippetMessage(
      msg({
        text: '',
        file: {docId: 'd', name: 's.md', fileKind: 'markdown', size: 4, content: '# x'}
      }),
      f,
      l
    ),
  voice: (f, l) => audioMessage(msg({kind: 'voice', text: 'said'}), f, l, () => {})
};

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = FakeIO;
  (URL as unknown as {createObjectURL: () => string}).createObjectURL = () => 'blob:test';
  (URL as unknown as {revokeObjectURL: () => void}).revokeObjectURL = () => {};
});

describe('every message bubble renders exactly one visible timestamp stamp', () => {
  for (const [name, make] of Object.entries(PRODUCERS)) {
    test(`${name}: one .cyc-stamp, one copy/quote pair`, () => {
      const node = make(true, true);
      const stamps = node.querySelectorAll('.cyc-stamp');
      expect(stamps, `${name}: exactly one stamp`).toHaveLength(1);

      expect(
        node.querySelectorAll('button.cyc-stamp-act[aria-hidden="true"]'),
        `${name}: no aria-hidden act twin`
      ).toHaveLength(0);

      const acts = [...node.querySelectorAll('.cyc-stamp-act')].map(
        (b) => (b as HTMLElement).dataset.act
      );
      if (name === 'album' || name === 'snippet') {
        expect(acts, `${name}: empty-body -> no acts`).toEqual([]);
      } else {
        expect(acts, `${name}: single copy/quote pair`).toEqual(['copy', 'quote']);
      }
    });
  }

  // 2026-09-02: the stamp must land bottom-right of every bubble (owner's phone
  // screenshots: the corner stamp painted over the card's size line, and the
  // inline stamp trailed the text wherever it ended). The flowing stamp now floats
  // at the inline end (Telegram/WhatsApp shape); the card stamp is the last item
  // of the size row, which reserves its width. The absolute corner stamp is gone.
  test('a flowing stamp floats at the inline end of its host', () => {
    const flow = flowStamp(msg({text: 'hi'}));
    expect(flow.classList.contains('cyc-stamp-flow')).toBe(true);
    expect(flow.classList.contains('float-end')).toBe(true);
    expect(flow.classList.contains('self-end')).toBe(true);
    expect(flow.classList.contains('mt-[3px]')).toBe(true);
    expect(flow.classList.contains('ms-2')).toBe(true);
    expect(flow.classList.contains('align-baseline')).toBe(false);
    expect(flow.classList.contains('absolute')).toBe(false);
  });

  test('a card stamp is a row item pushed to the inline end, never absolute', () => {
    const foot = footStamp(msg({text: 'hi'}));
    expect(foot.classList.contains('cyc-stamp-foot')).toBe(true);
    expect(foot.classList.contains('ms-auto')).toBe(true);
    expect(foot.classList.contains('shrink-0')).toBe(true);
    expect(foot.classList.contains('absolute')).toBe(false);
    expect(foot.classList.contains('float-end')).toBe(false);

    const size = document.createElement('div');
    const row = docFootRow(size, foot);
    expect(row.classList.contains('cyc-doc-foot')).toBe(true);
    expect(row.classList.contains('flex')).toBe(true);
    expect(row.classList.contains('items-end')).toBe(true);
    expect([...row.children]).toEqual([size, foot]);
    expect(size.classList.contains('min-w-0')).toBe(true);
    expect([...docFootRow(document.createElement('div'), null).children]).toHaveLength(1);
  });

  test('the text body clears its floated stamp, except in the multipart flex column', () => {
    const body = textMessage(msg({text: 'hi'}), true, true).querySelector('.cyc-message-text')!;
    for (const c of ["after:content-['']", 'after:block', 'after:clear-both']) {
      expect(body.classList.contains(c), c).toBe(true);
    }
    expect(body.classList.contains('[.cyc-message.cyc-multipart_&]:after:content-none')).toBe(true);
  });
});

describe('the stamp is the last thing in the bubble, at the inline end of its host', () => {
  const stampOf = (node: HTMLElement) => node.querySelector('.cyc-stamp')! as HTMLElement;

  test('text: last child of the text body', () => {
    const node = PRODUCERS.text(true, true);
    const body = node.querySelector('.cyc-message-text')!;
    expect(body.lastElementChild).toBe(stampOf(node));
  });

  const LONE_CARDS: Record<string, () => HTMLElement> = {
    'doc-lone': () => PRODUCERS['doc-lone'](true, true),
    'doc-download': () => PRODUCERS['doc-download'](true, true),
    'doc-upload-lone': () =>
      uploadMessage(msg({text: '', upload: doc('u2')}), true, true, 'http://x/u2.pdf')
  };
  for (const [name, make] of Object.entries(LONE_CARDS)) {
    test(`${name}: beside the size line in the card's foot row`, () => {
      const node = make();
      const stamp = stampOf(node);
      expect(stamp.classList.contains('cyc-stamp-foot')).toBe(true);
      const foot = stamp.parentElement!;
      expect(foot.classList.contains('cyc-doc-foot')).toBe(true);
      expect(foot.parentElement!.classList.contains('cyc-doc')).toBe(true);
      expect(foot.firstElementChild!.classList.contains('cyc-doc-size')).toBe(true);
      expect(foot.lastElementChild).toBe(stamp);
      // Nothing but the download button may follow the foot row inside the card.
      const after = [...foot.parentElement!.children].slice(
        [...foot.parentElement!.children].indexOf(foot) + 1
      );
      expect(after.every((el) => el.classList.contains('cyc-download-btn'))).toBe(true);
    });
  }

  for (const name of ['doc-caption', 'doc-upload']) {
    test(`${name}: rides the caption text, no card stamp`, () => {
      const node = PRODUCERS[name](true, true);
      const stamp = stampOf(node);
      expect(stamp.classList.contains('cyc-stamp-flow')).toBe(true);
      expect(stamp.closest('.cyc-doc-message.mt-\\[-0\\.125rem\\]')).not.toBeNull();
      expect(stamp.closest('.cyc-doc')).toBeNull();
      expect(stamp.parentElement!.lastElementChild).toBe(stamp);
      expect(node.querySelector('.cyc-doc-foot .cyc-stamp')).toBeNull();
    });
  }

  test('photo-caption: rides the caption; media-only: last child of the body', () => {
    const withCap = PRODUCERS['photo-caption'](true, true);
    expect(stampOf(withCap).parentElement!.classList.contains('caption')).toBe(true);
    const only = PRODUCERS['photo-media-only'](true, true);
    expect(only.querySelector('.cyc-message-text')!.lastElementChild).toBe(stampOf(only));
  });

  test('multipart: rides the trailing paragraph, else ends the column', () => {
    const withText = attachmentMessage(
      msg({text: 'look at these', uploads: [img('a'), img('b')]}),
      true,
      true,
      (u) => `http://x/${u!.uploadId}`
    );
    const paras = withText.querySelectorAll('.cyc-multipart-text');
    expect(paras.length).toBeGreaterThan(0);
    const lastPara = paras[paras.length - 1];
    expect(lastPara.lastElementChild).toBe(stampOf(withText));

    const albumOnly = PRODUCERS.album(true, true);
    expect(albumOnly.querySelector('.cyc-message-text')!.lastElementChild).toBe(stampOf(albumOnly));
  });

  test('voice: after the transcript, outside the karaoke walker', () => {
    const node = PRODUCERS.voice(true, true);
    const stamp = stampOf(node);
    expect(stamp.closest('.cyc-transcript')).toBeNull();
    expect(node.querySelector('.cyc-message-text')!.lastElementChild).toBe(stamp);
  });
});
