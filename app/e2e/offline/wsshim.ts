import {WebSocket, WebSocketServer as RawServer} from 'ws';
import {attachSeal} from './engine';
import type {Server} from 'http';

export {WebSocket};

export class WebSocketServer extends RawServer {
  constructor(opts?: ConstructorParameters<typeof RawServer>[0]) {
    super(opts);
    attachSeal(
      this,
      opts && typeof opts === 'object' && 'server' in opts
        ? {server: (opts as {server?: Server}).server}
        : undefined
    );
  }

  // ws 8 calls the close callback only once every tracked client has closed.
  // A spec sees a socket on its `connection` handler only after the seal's
  // handshake (sec-ok), so a client still mid-handshake (the app redialing
  // right after a page.reload) is in `clients` but not in the spec's own set:
  // the spec terminates what it knows, `close` then waits for the browser to
  // drop the other one, and the test times out. Every tracked client goes here.
  override close(cb?: (err?: Error) => void): void {
    for (const ws of this.clients) ws.terminate();
    super.close(cb);
  }
}
