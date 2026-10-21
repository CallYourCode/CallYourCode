import {test, expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {initClientGlue, mintSealedClient} from './client-glue.ts';
import {initFrames} from './frames.ts';
import {initTunnel} from './tunnel-glue.ts';
import {clients} from './wire.ts';
import {wireCore} from '../test-utils/wire-core.ts';
import {fakeVoice, pointVoiceAt, restoreVoiceUrls} from '../test-utils/fake-voice.ts';
import {until} from '../test-utils/wait.ts';
import {tunnelTmpDir} from '../storage/datadir.ts';
import {newIdentity, SecureChannel, secTranscript, signId, b64encode, derivePairKey, secPairTag} from '../../../shared/e2e.ts';
import {newestGen} from '../security/sec.ts';
import type {Pipe} from '../../../shared/ws-pipe.ts';

test('sealed client dependencies are wired before the outbound relay starts', () => {
  const boot = readFileSync(new URL('../runtime/server.ts', import.meta.url), 'utf8');
  expect(boot.indexOf('initClientGlue({')).toBeGreaterThan(0);
  expect(boot.indexOf('relayLink.start()')).toBeGreaterThan(boot.indexOf('initClientGlue({'));
});

for (const cause of ['relay disconnect', 'sealed replay'] as const) {
  test(`${cause} releases a live terminal, STT upstream and upload spool exactly once`, async () => {
    const core = await wireCore({with: ['frames', 'notify']});
    const voice = fakeVoice({greet: null, echo: false});
    pointVoiceAt(voice.base);
    let releases = 0;
    let markClosed = 0;
    let pipeClosed = false;
    const outgoing: any[] = [];
    const pipe: Pipe = {
      kind: 'ws', get open() {return !pipeClosed;},
      send(raw) {outgoing.push(JSON.parse(raw)); return !pipeClosed;},
      async drain() {},
      close(code = 1000, reason = '') {pipeClosed = true; pipe.onclose?.(code, reason);},
      onopen: null, onmessage: null, onclose: null,
    };
    try {
      initFrames({terminalCanResize: true, terminalPaneMode: async () => 'scroll', terminalViewer: () => true,
        openTerminal: () => ({resize() {}, input() {}, scroll() {}, release() {releases++;}}), log: core.log});
      initTunnel({routeRequest: async () => {throw new Error('an unfinished upload must not dispatch');},
        server: {} as import('bun').Server, log: core.log});
      initClientGlue({e2e: core.e2e!, engineUser: 'scratch', engineHost: 'scratch', log: core.log});
      mintSealedClient(pipe);
      const offer = await SecureChannel.offer();
      pipe.onmessage!(JSON.stringify({t: 'hello', sec: offer.hello}));
      await until(() => outgoing.some((f) => f.t === 'sec'), {what: 'signed engine handshake'});
      const chan = await SecureChannel.accept(offer, outgoing.find((f) => f.t === 'sec'), null);
      const dev = await newIdentity(true);
      const t = chan.transcript();
      const transcript = secTranscript('c', t.ce, t.ee, t.cn, t.en, t.id);
      const send = async (frame: unknown) => {
        const raw = JSON.stringify(await chan.seal(frame));
        pipe.onmessage!(raw);
        return raw;
      };
      await send({t: 'sec-ok', dev: dev.spki, label: 'cleanup test',
        sig: b64encode(await signId(dev.keyPair.privateKey, new TextEncoder().encode(transcript))),
        pair: await secPairTag(await derivePairKey(newestGen(core.e2e!).key), transcript)});
      await until(() => clients.size === 1, {what: 'sealed client readiness'});
      const sock = [...clients][0];
      const original = sock.data.sec!.markClosed.bind(sock.data.sec);
      sock.data.sec!.markClosed = () => {markClosed++; original();};
      const session = [...core.sessions.values()][0];
      await send({t: 'term-open', id: session.id, cols: 80, rows: 24});
      await send({t: 'stt-open', id: 'active-stt', rate: 16000, format: 'f32'});
      const replay = await send({t: 'req', id: 'half-upload', m: 'POST', p: '/upload', b: b64encode(new Uint8Array(4096)), more: true});
      await until(() => voice.streams === 1 && sock.data.terms.size === 1, {what: 'terminal and STT active'});
      await until(async () => (await readdir(tunnelTmpDir())).length === 1, {what: 'upload on disk'});
      if (cause === 'sealed replay') {
        pipe.onmessage!(replay);
        await until(() => pipeClosed, {what: 'replay refusal'});
      } else pipe.close(1001, 'relay disconnected');
      // Real WS errors and close notifications can converge on the same cleanup.
      pipe.onclose!(1006, 'second notification');
      pipe.close(1001, 'late relay shutdown');
      await until(() => voice.streams === 0, {what: 'upstream released'});
      await until(async () => (await readdir(tunnelTmpDir())).length === 0, {what: 'spool unlinked'});
      expect(markClosed).toBe(1);
      expect(releases).toBe(1);
      expect(sock.data.terms.size).toBe(0);
      expect(clients.has(sock)).toBe(false);
      expect(core.logs.filter((l) => l.event === 'client.close')).toHaveLength(1);
    } finally {
      pipe.close();
      voice.stop();
      restoreVoiceUrls();
      await core.stop();
    }
  });
}
