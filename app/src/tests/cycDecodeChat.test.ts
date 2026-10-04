import {describe, expect, test} from 'vitest';
import {decodeChat, decodePage, parseSessionEvent} from '../engine/decodeChat';
describe('decodeChat: the frame envelope', () => {
  test('rejects anything that is not an object', () => {
    expect(decodeChat(null)).toBeNull();
    expect(decodeChat(undefined)).toBeNull();
    expect(decodeChat('chat')).toBeNull();
    expect(decodeChat(42)).toBeNull();
  });
  test('minimal frame: defaults are rebuilt, not passed through', () => {
    const m = decodeChat({id: 's1'})!;
    expect(m.id).toBe('s1');
    expect(m.role).toBe('user');
    expect(m.text).toBe('');
    expect(m.ts).toBeGreaterThan(0);
    expect(m.seq).toBeUndefined();
    expect(m.msgId).toBeUndefined();
  });
  test('role: only the literal claude is claude', () => {
    expect(decodeChat({id: 's', role: 'claude'})!.role).toBe('claude');
    expect(decodeChat({id: 's', role: 'CLAUDE'})!.role).toBe('user');
    expect(decodeChat({id: 's', role: 7})!.role).toBe('user');
  });
  test('scalar carries: seq, msgId, kind, queued, cid, durationS, growing', () => {
    const m = decodeChat({
      id: 's',
      seq: 12,
      msgId: 'm1',
      kind: 'voice',
      queued: 1,
      cid: 'c1',
      durationS: 3.5,
      growing: true
    })!;
    expect(m.seq).toBe(12);
    expect(m.msgId).toBe('m1');
    expect(m.kind).toBe('voice');
    expect(m.queued).toBe(true);
    expect(m.cid).toBe('c1');
    expect(m.durationS).toBe(3.5);
    expect(m.growing).toBe(true);
  });
  test('scalar drops: bad seq, empty cid, non-voice kind, falsy growing', () => {
    const m = decodeChat({id: 's', seq: 'twelve', cid: '', kind: 'video', growing: 'yes'})!;
    expect(m.seq).toBeUndefined();
    expect(m.cid).toBeUndefined();
    expect(m.kind).toBeUndefined();
    expect(m.growing).toBeUndefined();
  });
  test('transcript state: wordsFailed and transcriptPending only on exact true', () => {
    const on = decodeChat({id: 's', wordsFailed: true, transcriptPending: true})!;
    expect(on.wordsFailed).toBe(true);
    expect(on.transcriptPending).toBe(true);
    const off = decodeChat({id: 's', wordsFailed: 'true', transcriptPending: 1})!;
    expect(off.wordsFailed).toBeUndefined();
    expect(off.transcriptPending).toBeUndefined();
  });
  test('scheduled: a non-empty string only', () => {
    expect(decodeChat({id: 's', scheduled: 'daily-note'})!.scheduled).toBe('daily-note');
    expect(decodeChat({id: 's', scheduled: ''})!.scheduled).toBeUndefined();
    expect(decodeChat({id: 's', scheduled: 5})!.scheduled).toBeUndefined();
  });
});
describe('decodeChat: the file card', () => {
  test('needs a non-empty docId', () => {
    expect(decodeChat({id: 's', file: {name: 'a.md'}})!.file).toBeUndefined();
    expect(decodeChat({id: 's', file: {docId: ''}})!.file).toBeUndefined();
  });
  test('kind whitelist: unknown kinds degrade to text, binary survives', () => {
    const kinds = (k: unknown) =>
      decodeChat({id: 's', file: {docId: 'd', fileKind: k}})!.file!.fileKind;
    expect(kinds('markdown')).toBe('markdown');
    expect(kinds('diff')).toBe('diff');
    expect(kinds('image')).toBe('image');
    expect(kinds('html')).toBe('html');
    expect(kinds('binary')).toBe('binary');
    expect(kinds('mystery')).toBe('text');
    expect(kinds(undefined)).toBe('text');
  });
  test('inline/content ride only on kinds that may render inline', () => {
    const md = decodeChat({
      id: 's',
      file: {docId: 'd', fileKind: 'markdown', inline: true, content: '# hi'}
    })!.file!;
    expect(md.inline).toBe(true);
    expect(md.content).toBe('# hi');

    const html = decodeChat({
      id: 's',
      file: {docId: 'd', fileKind: 'html', inline: true, content: '<b>'}
    })!.file!;
    expect(html.inline).toBeUndefined();
    expect(html.content).toBeUndefined();

    const bin = decodeChat({
      id: 's',
      file: {docId: 'd', fileKind: 'binary', inline: true, content: 'xx'}
    })!.file!;
    expect(bin.inline).toBeUndefined();
    expect(bin.content).toBeUndefined();
  });
  test('name and size are rebuilt with defaults', () => {
    const f = decodeChat({id: 's', file: {docId: 'd', size: 'big'}})!.file!;
    expect(f.name).toBe('file');
    expect(f.size).toBe(0);
  });
});
describe('decodeChat: attachments', () => {
  test('upload needs a non-empty uploadId', () => {
    expect(decodeChat({id: 's', upload: {name: 'x'}})!.upload).toBeUndefined();
    expect(decodeChat({id: 's', upload: {uploadId: ''}})!.upload).toBeUndefined();
  });
  test('every field is sanitised with defaults', () => {
    const u = decodeChat({id: 's', upload: {uploadId: 'u1'}})!.upload!;
    expect(u).toEqual({
      uploadId: 'u1',
      name: 'file',
      mime: 'application/octet-stream',
      size: 0,
      path: '',
      image: false
    });
  });
  test('at is kept INCLUDING ZERO; negative and NaN are dropped', () => {
    const at = (v: unknown) => decodeChat({id: 's', upload: {uploadId: 'u', at: v}})!.upload!.at;
    expect(at(0)).toBe(0);
    expect(at(7)).toBe(7);
    expect(at(-1)).toBeUndefined();
    expect(at('x')).toBeUndefined();
  });
  test('durationS and textLen only when positive', () => {
    const u = decodeChat({id: 's', upload: {uploadId: 'u', durationS: 0, textLen: 0}})!.upload!;
    expect(u.durationS).toBeUndefined();
    expect(u.textLen).toBeUndefined();
    const v = decodeChat({id: 's', upload: {uploadId: 'u', durationS: 2.5, textLen: 8}})!.upload!;
    expect(v.durationS).toBe(2.5);
    expect(v.textLen).toBe(8);
  });
  test('fromPage needs both label and page as strings', () => {
    const good = decodeChat({
      id: 's',
      upload: {uploadId: 'u', fromPage: {label: 'submit', page: 'show-decision.html'}}
    })!.upload!;
    expect(good.fromPage).toEqual({label: 'submit', page: 'show-decision.html'});
    const bad = decodeChat({
      id: 's',
      upload: {uploadId: 'u', fromPage: {label: 'submit'}}
    })!.upload!;
    expect(bad.fromPage).toBeUndefined();
  });
  test('width/height ride only as a pair of positive numbers (#437)', () => {
    const wh = (w: unknown, h: unknown) => {
      const u = decodeChat({id: 's', upload: {uploadId: 'u', width: w, height: h}})!.upload!;
      return [u.width, u.height];
    };
    expect(wh(640, 480)).toEqual([640, 480]);
    expect(wh(640, 0)).toEqual([undefined, undefined]);
    expect(wh(NaN, 480)).toEqual([undefined, undefined]);
  });
  test('uploads[]: malformed entries drop, upload backfills from the first', () => {
    const m = decodeChat({
      id: 's',
      uploads: [{uploadId: 'a', name: 'one'}, {name: 'no-id'}, {uploadId: 'b', name: 'two'}]
    })!;
    expect(m.uploads!.map((u) => u.uploadId)).toEqual(['a', 'b']);
    expect(m.upload!.uploadId).toBe('a');
  });
  test('an explicit upload is not overwritten by uploads[0]', () => {
    const m = decodeChat({id: 's', upload: {uploadId: 'first'}, uploads: [{uploadId: 'other'}]})!;
    expect(m.upload!.uploadId).toBe('first');
  });
  test('uploads[] of only malformed entries leaves both fields absent', () => {
    const m = decodeChat({id: 's', uploads: [{name: 'x'}, null]})!;
    expect(m.uploads).toBeUndefined();
    expect(m.upload).toBeUndefined();
  });
});
describe('parseSessionEvent', () => {
  test('needs an id (the engine record id; `uuid` accepted), a kind and a finite ts', () => {
    expect(parseSessionEvent(null)).toBeNull();
    expect(parseSessionEvent({ts: 1, kind: 'tool'})).toBeNull();
    expect(parseSessionEvent({uuid: 'u', ts: 'now', kind: 'tool'})).toBeNull();
    expect(parseSessionEvent({id: 'se-1', ts: 1, kind: 'tool', text: 't'})!.uuid).toBe('se-1');
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: 'tool', text: 't'})!.uuid).toBe('u');
  });
  test('kind is open: any named kind is held, seq rides along, no kind is null', () => {
    for (const kind of [
      'prompt',
      'reply',
      'tool',
      'compact',
      'interrupt',
      'status',
      'ask',
      'mux'
    ]) {
      expect(parseSessionEvent({uuid: 'u', ts: 1, kind, text: 't'})!.kind).toBe(kind);
    }
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: 'note', text: 't', seq: 12})!.seq).toBe(12);
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: 'note', text: 't'})!.seq).toBeUndefined();
    expect(parseSessionEvent({uuid: 'u', ts: 1})).toBeNull();
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: ''})).toBeNull();
  });
  test('a halt is not a prompt: the interrupt records reclassify', () => {
    for (const text of [
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
      '>  [Request interrupted by user]'
    ]) {
      const ev = parseSessionEvent({uuid: 'u', ts: 1, kind: 'prompt', text})!;
      expect(ev.kind).toBe('interrupt');
      expect(ev.text).toBe('interrupted by user');
    }
  });
  test('a prompt that merely mentions an interrupt stays a prompt', () => {
    const ev = parseSessionEvent({
      uuid: 'u',
      ts: 1,
      kind: 'prompt',
      text: 'why did [Request interrupted by user] appear?'
    })!;
    expect(ev.kind).toBe('prompt');
  });
  test("tool name rides only as a non-empty string, from a string or the record's {name}", () => {
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: 'tool', tool: 'Bash'})!.tool).toBe('Bash');
    expect(
      parseSessionEvent({uuid: 'u', ts: 1, kind: 'tool', tool: {name: 'Read', input: {}}})!.tool
    ).toBe('Read');
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: 'tool', tool: ''})!.tool).toBeUndefined();
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: 'tool', tool: 9})!.tool).toBeUndefined();
    expect(parseSessionEvent({uuid: 'u', ts: 1, kind: 'tool', tool: {}})!.tool).toBeUndefined();
  });
});
describe('decodePage', () => {
  test('splits one page into messages and t:s records; junk rows drop, the rest keep their seqs', () => {
    const page = decodePage({
      page: 3,
      version: 302,
      sealed: true,
      messages: [
        {id: 'ag-1', role: 'user', text: 'hi', ts: 1, seq: 300},
        {t: 's', seq: 301, ts: 2, id: 'se-a', kind: 'tool', text: 'Bash ls', tool: {name: 'Bash'}},
        {t: 's', seq: 302, ts: 3, kind: 'tool', text: 'no id'},
        'garbage',
        null,
        {id: 'ag-1', role: 'claude', text: 'hello', ts: 4, seq: 303}
      ]
    });
    expect(page).toMatchObject({page: 3, version: 302, sealed: true});
    expect(page.messages.map((m) => [m.role, m.seq])).toEqual([
      ['user', 300],
      ['claude', 303]
    ]);
    expect(page.events).toEqual([
      {uuid: 'se-a', ts: 2, seq: 301, kind: 'tool', text: 'Bash ls', tool: 'Bash'}
    ]);
  });
  test('a page from before the log (no t:s rows) reads as messages and no events', () => {
    const page = decodePage({
      page: 0,
      version: 2,
      sealed: false,
      messages: [{id: 'a', role: 'user', text: 'x', ts: 1, seq: 0}]
    });
    expect(page.events).toEqual([]);
    expect(page.messages.length).toBe(1);
    expect(decodePage(undefined)).toEqual({
      page: 0,
      version: 0,
      sealed: false,
      messages: [],
      events: []
    });
  });
});
