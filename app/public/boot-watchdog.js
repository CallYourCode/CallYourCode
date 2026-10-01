// BOOT WATCHDOG. index.html loaded, but the hashed entry chunk or the
// lazily-imported main may never run (a cache-first shell pointing at a chunk
// that is not cached while the network cannot deliver it: the black screen the
// owner force-closes out of). The main module calls window.__cycBootOk() the
// moment it starts; if that has not happened and #cyc-app is still empty after
// the grace window, beacon one line to /clientlog so the stuck boot names
// itself. No framework, no imports: this runs even when every module fetch
// hangs. /clientlog is same-origin and, in hosted mode, drops lines without a
// signed-in device, so the privacy gate still holds.
//
// This lives in its own same-origin file (not inline in index.html) because the
// app's served CSP is script-src 'self' blob: with no 'unsafe-inline', no nonce
// and no hash: an inline <script> is blocked outright and never runs. A plain
// <script src="/boot-watchdog.js"> is 'self', so it runs under the real policy.
// The build precaches it alongside the shell (scripts/build-cyc.sh adds it to
// cyc-precache.json; cyc-sw.js serves /boot-watchdog.js from cache), so it is
// present on an offline boot too, exactly when a stuck boot is most likely.
(function () {
  try {
    var booted = false;
    var start = Date.now();
    window.__cycBootOk = function () {
      booted = true;
    };
    setTimeout(function () {
      var app = document.getElementById('cyc-app');
      if (booted || (app && app.childElementCount > 0)) return;
      var dev;
      try {
        dev = localStorage.getItem('cyc-device-tag') || 'nostore';
      } catch (e) {
        dev = 'nostore';
      }
      var pg = Math.random().toString(36).slice(2, 7);
      var line =
        new Date().toISOString() +
        ' app boot.watchdog dev=' +
        dev +
        ' pg=' +
        pg +
        ' waited=' +
        (Date.now() - start) +
        ' reason=main-did-not-start';
      try {
        navigator.sendBeacon(
          '/clientlog',
          new Blob([JSON.stringify({device: dev, page: pg, lines: [line]})], {
            type: 'application/json'
          })
        );
      } catch (e) {}
    }, 8000);
  } catch (e) {}
})();
