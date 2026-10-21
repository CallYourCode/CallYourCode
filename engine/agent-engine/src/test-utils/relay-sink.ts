/* Real production relay with a scratch HTTP push/enrolment sink behind it. */
import {Relay, mintConnId, type RelayWsData} from '../../../../server/src/delivery/relay';
import {ENVELOPE_MAX, QUEUE_MAX} from '../../../shared/ws-pipe';
import {pushSink} from './push-sink';
export function relaySink() {
  const sink = pushSink();
  const tokens = new Map<string, string>();
  const relay = new Relay(() => {});
  const server = Bun.serve<RelayWsData>({
    port: 0, hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/engine') {
        const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
        const engineId = tokens.get(token);
        if (!engineId || engineId !== url.searchParams.get('engine')) return new Response('unauthorized', {status: 401});
        return srv.upgrade(req, {data: {relay: 'engine', engineId}}) ? undefined : new Response('upgrade', {status: 426});
      }
      if (url.pathname === '/device') {
        return srv.upgrade(req, {data: {relay: 'device', engineId: url.searchParams.get('engine') ?? '', connId: mintConnId()}}) ? undefined : new Response('upgrade', {status: 426});
      }
      const body = req.method === 'GET' ? undefined : await req.text();
      const response = await fetch(sink.url + url.pathname + url.search, {method: req.method, headers: req.headers, body});
      if (url.pathname === '/engines/enroll' && response.ok && body) {
        const {engineId} = JSON.parse(body);
        const {token} = await response.clone().json() as {token: string};
        tokens.set(token, engineId);
      }
      return response;
    },
    websocket: {
      maxPayloadLength: ENVELOPE_MAX, backpressureLimit: QUEUE_MAX,
      closeOnBackpressureLimit: true, idleTimeout: 0,
      open: (ws) => relay.open(ws),
      message: (ws, raw) => relay.message(ws, typeof raw === 'string' ? raw : new Uint8Array()),
      close: (ws) => relay.close(ws),
    },
  });
  return {...sink, url: `http://127.0.0.1:${server.port}`, stop() { server.stop(true); sink.stop(); }};
}
