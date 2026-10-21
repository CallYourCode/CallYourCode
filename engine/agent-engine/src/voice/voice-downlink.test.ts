/* Spoken replies are growing MP3 clips, announced over the sealed client. */
import {test, expect, afterEach} from 'bun:test';
import {initTts, speakClip, resetForTest} from './tts';
import {initClips, audioPath} from '../chat/clips';
import type {ChatMsg} from '../chat/chatmsg';
import {until} from '../test-utils/wait';
afterEach(resetForTest);

test('multi-chunk speech announces growth and final delivery without a second synthesis path', async () => {
  await initClips({blobOwner: () => new Map(), agentIdFor: () => "scratch"});
  const frames: any[] = [];
  const asked: string[] = [];
  const srv = Bun.serve({port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as {text: string};
    asked.push(body.text);
    return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 1, 2]), {headers: {'content-type': 'audio/mpeg'}});
  }});
  try {
    initTts({voiceUrl: async () => `http://127.0.0.1:${srv.port}`, voiceFor: () => undefined,
      persistPatch: () => {}, broadcast: (f) => frames.push(f), restoredChats: () => new Map()});
    const msgId = 'ws-voice-' + crypto.randomUUID();
    const msg: ChatMsg = {id: 's1', role: 'claude', text: 'One. Two.', ts: 1, msgId, growing: true};
    await speakClip({id: 's1'}, msg, ['One.', 'Two.'], msgId);
    await until(() => frames.some((f) => f.t === 'say-done'), {timeoutMs: 5000});
    expect(asked).toEqual(['One.', 'Two.']);
    expect(frames.filter((f) => f.t === 'say').length).toBe(1);
    expect(frames.some((f) => f.t === 'say-grow')).toBe(true);
    expect(await Bun.file(audioPath(msgId, 'audio/mpeg')).size).toBe(14);
    expect(msg.growing).toBeUndefined();
  } finally { srv.stop(true); }
});

test('failed synthesis leaves written reply without a stuck growing clip', async () => {
  await initClips({blobOwner: () => new Map(), agentIdFor: () => "scratch"});
  const frames: any[] = [];
  initTts({voiceUrl: async () => 'http://127.0.0.1:1', voiceFor: () => undefined,
    persistPatch: () => {}, broadcast: (f) => frames.push(f), restoredChats: () => new Map()});
  const msg: ChatMsg = {id: 's1', role: 'claude', text: 'One.', ts: 1, msgId: 'failed', growing: true};
  await speakClip({id: 's1'}, msg, ['One.'], 'failed');
  expect(msg.msgId).toBeUndefined();
  expect(msg.growing).toBeUndefined();
  expect(frames.map((f) => f.t)).toEqual(['chat']);
});
