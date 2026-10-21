import {test, expect} from 'bun:test';
import {RelayLink, resolveRelayUrl} from './relay';
import {Relay, mintConnId, type RelayWsData} from '../../../../server/src/delivery/relay';
import {wsPipe, type Pipe} from '../../../shared/ws-pipe';
import {until} from '../test-utils/wait';

test('relay URL preserves engine identity and configured origin', () => {
  expect(resolveRelayUrl('https://box.test', 'engine')).toBe('wss://box.test/engine?engine=engine');
  expect(resolveRelayUrl('', 'engine')).toBeNull();
});

test('real relay keeps opaque sealed strings alive beyond 300 frames and closes clients with engine', async () => {
  const relay = new Relay(() => {});
  const server = Bun.serve<RelayWsData>({port: 0, hostname: '127.0.0.1',
    fetch(req, srv) {
      const engine = new URL(req.url).pathname === '/engine';
      return srv.upgrade(req, {data: engine ? {relay: 'engine', engineId: 'e'} :
        {relay: 'device', engineId: 'e', connId: mintConnId()}}) ? undefined : new Response('', {status: 426});
    },
    websocket: {open: (ws) => relay.open(ws), message: (ws, raw) => relay.message(ws, typeof raw === 'string' ? raw : new Uint8Array()), close: (ws) => relay.close(ws)},
  });
  let enginePipe: Pipe | null = null;
  const link = new RelayLink({url: async () => `ws://127.0.0.1:${server.port}/engine`, token: async () => 'scratch',
    onAuthReject: () => {}, onRelayAuth: async () => true, log: () => {},
    onPipe: (p) => { enginePipe = p; p.onmessage = (s) => p.send(s); },
  });
  let device: Pipe | null = null;
  try {
    link.start();
    await until(() => link.connected, {timeoutMs: 3000});
    device = wsPipe(new WebSocket(`ws://127.0.0.1:${server.port}/device`));
    let ready = false;
    let count = 0;
    let closed = 0;
    device.onmessage = (s) => {
      const m = JSON.parse(s);
      if (m.t === 'r-challenge') device!.send(JSON.stringify({t: 'r-auth', spki: 'scratch', sig: 'scratch'}));
      else if (m.t === 'r-ok') ready = true;
      else { expect(m.t).toBe('x'); count++; }
    };
    device.onclose = () => closed++;
    await until(() => ready, {timeoutMs: 3000});
    for (let n = 0; n < 350; n++) device.send(JSON.stringify({t: 'x', n, data: 'opaque'}));
    await until(() => count === 350, {timeoutMs: 3000});
    expect(enginePipe).not.toBeNull();
    link.stop();
    await until(() => closed === 1, {timeoutMs: 3000});
    expect(count).toBe(350);
  } finally { device?.close(); link.stop(); server.stop(true); }
});
