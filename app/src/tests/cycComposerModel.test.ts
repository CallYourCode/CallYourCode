import {describe, expect, test} from 'vitest';
import {
  liftQuotes,
  messageParts,
  sendPlan,
  renderParts,
  sendLayout,
  type ComposerBlock,
  type Staged
} from '../features/composer/components/composerModel';
const staged = (name = 'a.webm'): Staged => ({
  file: new File(['x'], name),
  upload: null,
  progress: 0,
  done: true,
  error: null
});
describe('liftQuotes', () => {
  test('plain text is one text part', () => {
    expect(liftQuotes('hello there')).toEqual([{kind: 'text', text: 'hello there'}]);
  });
  test('a maximal run of quoted lines is ONE quote', () => {
    expect(liftQuotes('> one\n> two\nplain')).toEqual([
      {kind: 'quote', text: 'one\ntwo'},
      {kind: 'text', text: 'plain'}
    ]);
  });
  test('up to three leading spaces is a marker; four is code', () => {
    expect(liftQuotes('   > quoted')).toEqual([{kind: 'quote', text: 'quoted'}]);
    expect(liftQuotes('    > indented code')).toEqual([{kind: 'text', text: '> indented code'}]);
  });
  test('nothing inside a fence is markup', () => {
    const typed = '```\n> not a quote\n```';
    expect(liftQuotes(typed)).toEqual([{kind: 'text', text: typed}]);
  });
  test('one optional space after the > is eaten and no more', () => {
    expect(liftQuotes('> plain\n>   indented')).toEqual([
      {kind: 'quote', text: 'plain\n  indented'}
    ]);
  });
});
describe('messageParts', () => {
  test('blocks in order, then the typed text', () => {
    const blocks: ComposerBlock[] = [
      {kind: 'quote', text: 'quoted words'},
      {kind: 'prompt', text: 'be brief'},
      {kind: 'voice', clip: {durationS: 2, text: 'spoken words'}}
    ];
    expect(messageParts(blocks, 'typed words')).toEqual([
      {kind: 'quote', text: 'quoted words'},
      {kind: 'text', text: 'be brief'},
      {kind: 'text', text: 'spoken words'},
      {kind: 'text', text: 'typed words'}
    ]);
  });
  test('a reply and an attachment contribute no words', () => {
    const blocks: ComposerBlock[] = [
      {kind: 'reply', reply: {ts: 1, role: 'claude' as const, title: 'Claude', text: 'source'}},
      {kind: 'attach', staged: staged('p.png')}
    ];
    expect(messageParts(blocks, '')).toEqual([]);
  });
  test('an unsure clip with audio going keeps its fragment out of the body', () => {
    const blocks: ComposerBlock[] = [
      {kind: 'voice', clip: {durationS: 2, text: 'half a sen', unsure: true}, staged: staged()}
    ];
    expect(messageParts(blocks, '')).toEqual([]);
  });
  test('an unsure clip with NO audio still contributes its words', () => {
    const blocks: ComposerBlock[] = [
      {kind: 'voice', clip: {durationS: 2, text: 'half a sen', unsure: true, lost: true}}
    ];
    expect(messageParts(blocks, '')).toEqual([{kind: 'text', text: 'half a sen'}]);
  });
});
describe('sendPlan', () => {
  test('the first sourced quote becomes the reply and leaves the body', () => {
    const src = {ts: 5, role: 'claude' as const, title: 'Claude', text: 'origin'};
    const blocks: ComposerBlock[] = [
      {kind: 'quote', text: 'typed quote'},
      {kind: 'quote', text: 'from a message', source: src}
    ];
    const plan = sendPlan(blocks, '');
    expect(plan.answering).toBe(src);
    expect(plan.body).toHaveLength(1);
    expect(plan.parts).toEqual([{kind: 'quote', text: 'typed quote'}]);
  });
  test('a reply block outranks a sourced quote, which then stays words', () => {
    const replyTo = {ts: 1, role: 'user' as const, title: 'You', text: 'r'};
    const src = {ts: 5, role: 'claude' as const, title: 'Claude', text: 'origin'};
    const blocks: ComposerBlock[] = [
      {kind: 'reply', reply: replyTo},
      {kind: 'quote', text: 'from a message', source: src}
    ];
    const plan = sendPlan(blocks, '');
    expect(plan.answering).toBe(replyTo);
    expect(plan.parts).toEqual([{kind: 'quote', text: 'from a message'}]);
  });
});
describe('renderParts', () => {
  test('quotes get > prefixes and parts join with a blank line', () => {
    expect(
      renderParts([
        {kind: 'quote', text: 'a\nb'},
        {kind: 'text', text: 'c'}
      ])
    ).toBe('> a\n> b\n\nc');
  });
});
describe('sendLayout', () => {
  test('a file sits at the offset of whatever is placed next', () => {
    const blocks: ComposerBlock[] = [{kind: 'attach', staged: staged('p.png')}];
    const {text, anchors} = sendLayout(blocks, 'caption');
    expect(text).toBe('caption');
    expect(anchors).toEqual([{at: 0, textLen: 0}]);
  });
  test('a clip owns its transcript span; a file waits for whatever is placed next', () => {
    const blocks: ComposerBlock[] = [
      {kind: 'voice', clip: {durationS: 2, text: 'spoken'}, staged: staged()},
      {kind: 'attach', staged: staged('p.png')}
    ];
    const {text, anchors} = sendLayout(blocks, 'typed');
    expect(text).toBe('spoken\n\ntyped');
    expect(anchors).toEqual([
      {at: 0, textLen: 6},
      {at: text.indexOf('typed'), textLen: 0}
    ]);
  });
  test('a trailing file with nothing after it lands at the end', () => {
    const blocks: ComposerBlock[] = [
      {kind: 'prompt', text: 'be brief'},
      {kind: 'attach', staged: staged('p.png')}
    ];
    const {text, anchors} = sendLayout(blocks, '');
    expect(text).toBe('be brief');
    expect(anchors).toEqual([{at: text.length, textLen: 0}]);
  });
  test("a pending marker takes the transcript's place", () => {
    const st = staged();
    const blocks: ComposerBlock[] = [{kind: 'voice', clip: {durationS: 2, text: ''}, staged: st}];
    const {text, anchors} = sendLayout(blocks, 'after', (s) => (s === st ? '[[clip]]' : undefined));
    expect(text).toBe('[[clip]]\n\nafter');
    expect(anchors).toEqual([{at: 0, textLen: 8}]);
  });
});
