// A scratch app origin for the deploy-update specs, run under bun: the app
// server's REAL static answer (server/src/platform/static.ts serveStatic, so the
// same Cache-Control and security headers the live origin sends) over a dist
// directory the spec can swap, which is a deploy. Test-only control route:
//   GET /__deploy?dist=<abs dir>&fail=1  serve that dist; with fail=1 the shell
//   and assets/ answer 503 (the radio dying under a precache), while build.txt,
//   cyc-sw.js and cyc-precache.json still answer so the update is discovered.
// Prints "LISTENING <port>" once up. Never binds a live port (port 0).
import {serveStatic} from '../../../server/src/platform/static';

const state = {dist: process.argv[2] ?? '', fail: false};
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
      return new Response('ok');
    }
    if (state.fail && (p === '/' || p === '/index.html' || p.startsWith('/assets/')))
      return new Response('unavailable', {status: 503});
    return serveStatic(state.dist, p);
  }
});

console.log('LISTENING ' + server.port);
