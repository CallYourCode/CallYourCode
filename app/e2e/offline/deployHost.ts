// A scratch app origin for the deploy-update specs, run under bun: the app
// server's REAL static answer (server/src/platform/static.ts serveStatic, so the
// same Cache-Control and security headers the live origin sends) over a dist
// directory the spec can swap, which is a deploy. Test-only control route:
//   GET /__deploy?dist=<abs dir>&fail=1  serve that dist; with fail=1 the shell
//   and assets/ answer 503 (the radio dying under a precache), with stall=1
//   they never answer (a stalled radio: the install runs for minutes), while
//   build.txt, cyc-sw.js and cyc-precache.json still answer so the update is
//   discovered.
//   GET /assets/zz-hold-forever.js never answers: a request in flight through
//   the active worker, which keeps a new worker WAITING (both browsers).
// Prints "LISTENING <port>" once up. Never binds a live port (port 0).
import {serveStatic} from '../../../server/src/platform/static';

const state = {dist: process.argv[2] ?? '', fail: false, stall: false};
if (!state.dist) throw new Error('deployHost: pass the first dist directory');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/__deploy') {
      state.dist = url.searchParams.get('dist') || state.dist;
      state.fail = url.searchParams.get('fail') === '1';
      state.stall = url.searchParams.get('stall') === '1';
      return new Response('ok');
    }
    if (p === '/assets/zz-hold-forever.js') return new Promise<Response>(() => {});
    const precached = p === '/' || p === '/index.html' || p.startsWith('/assets/');
    if (state.fail && precached) return new Response('unavailable', {status: 503});
    // Only the worker's precache (cache: 'reload') stalls; the page's own loads
    // of the build it runs still answer.
    if (state.stall && precached && req.headers.get('cache-control') === 'no-cache')
      return new Promise<Response>(() => {});
    return serveStatic(state.dist, p);
  }
});

console.log('LISTENING ' + server.port);
