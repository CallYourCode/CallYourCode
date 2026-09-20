import {describe, expect, test, vi, beforeEach} from 'vitest';
async function loadContract(cfg: unknown) {
  vi.resetModules();
  if (cfg === null) localStorage.removeItem('cyc-config');
  else localStorage.setItem('cyc-config', JSON.stringify(cfg));
  return import('../engine/contract');
}
const HOSTED_CFG = {
  engines: [
    'ws://seed.only:7788/ws',
    {url: 'wss://home.tail1234.ts.net/ws', engineId: 'eng-home', host: 'home', user: 'example'}
  ],
  voice: null as string | null,
  auth: 'clerk',
  rtc: {
    iceServers: [
      {urls: ['stun:stun.cloudflare.com:3478']},
      {urls: 'stun:stun.l.google.com:19302'},
      {urls: ['turn:t.example.com:3478'], username: '123:me', credential: 'c='}
    ]
  }
};

const sameOrigin = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
describe('rtc config readers', () => {
  beforeEach(() => localStorage.clear());
  test('rtcIceServers: browser shape out, string urls normalised, garbage dropped whole', async () => {
    const c = await loadContract({
      ...HOSTED_CFG,
      rtc: {
        ...HOSTED_CFG.rtc,
        iceServers: [
          ...HOSTED_CFG.rtc.iceServers,
          {urls: ['http://not-ice']},
          {urls: 42},
          {urls: ['turns:t:5349'], username: 'u'}
        ]
      }
    });
    expect(c.rtcIceServers()).toEqual([
      {urls: ['stun:stun.cloudflare.com:3478']},
      {urls: ['stun:stun.l.google.com:19302']},
      {urls: ['turn:t.example.com:3478'], username: '123:me', credential: 'c='},
      {urls: ['turns:t:5349']}
    ]);
  });
  test('rtcIceServers is [] with no config and with an old app server (no rtc field)', async () => {
    expect((await loadContract(null)).rtcIceServers()).toEqual([]);
    expect(
      (await loadContract({engines: ['ws://x:7788/ws'], voice: null})).rtcIceServers()
    ).toEqual([]);
  });
  test('relaySignalUrlFor: an announced engine gets the same-origin /device url naming its engineId', async () => {
    const c = await loadContract(HOSTED_CFG);
    expect(c.relaySignalUrlFor('wss://home.tail1234.ts.net/ws')).toBe(
      `${sameOrigin}/device?engine=eng-home`
    );
  });
  test('relaySignalUrlFor: same-origin in LOCAL too; null only for un-announced engines', async () => {
    const c = await loadContract(HOSTED_CFG);

    expect(c.relaySignalUrlFor('ws://seed.only:7788/ws')).toBeNull();

    expect(c.relaySignalUrlFor('ws://stranger:7788/ws')).toBeNull();

    const local = await loadContract({
      ...HOSTED_CFG,
      auth: 'none',
      rtc: {iceServers: HOSTED_CFG.rtc.iceServers}
    });
    expect(local.relaySignalUrlFor('wss://home.tail1234.ts.net/ws')).toBe(
      `${sameOrigin}/device?engine=eng-home`
    );

    expect((await loadContract(null)).relaySignalUrlFor('ws://x:7788/ws')).toBeNull();
  });
});
describe('RtcDial ice servers', () => {
  test('the peer connection is built with exactly the servers handed in; [] by default', async () => {
    vi.resetModules();
    const seen: RTCConfiguration[] = [];
    class FakePc {
      localDescription = {sdp: 'v=0'};
      onicecandidate: unknown = null;
      oniceconnectionstatechange: unknown = null;
      iceConnectionState = 'new';
      constructor(cfg: RTCConfiguration) {
        seen.push(cfg);
      }
      createDataChannel() {
        return {binaryType: '', onopen: null as (() => void) | null};
      }
      createOffer() {
        return Promise.resolve({type: 'offer', sdp: 'v=0'});
      }
      setLocalDescription() {
        return Promise.resolve();
      }
      close() {}
    }
    vi.stubGlobal('RTCPeerConnection', FakePc as unknown as typeof RTCPeerConnection);
    const {RtcDial} = await import('../engine/rtc');
    const signal = {
      send: () => {},
      onframe: null as ((m: unknown) => void) | null,
      close: () => {},
      onclose: null as ((code: number) => void) | null
    };
    const ice = [{urls: ['stun:s:3478']}];
    const d1 = new RtcDial(signal, ice);
    d1.start().catch(() => {});
    const d2 = new RtcDial(signal);
    d2.start().catch(() => {});
    await Promise.resolve();
    expect(seen[0]).toEqual({iceServers: ice});
    expect(seen[1]).toEqual({iceServers: []});
    d1.close('test-done');
    d2.close('test-done');
    vi.unstubAllGlobals();
  });
});
