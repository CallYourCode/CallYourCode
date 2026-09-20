# Interactive pages: the show tool, the cyc API, the limits

`show` takes one argument: an absolute `path`. The file must live under the
session's cwd, the OS tmpdir, or the `/tmp/claude-*` scratchpad tree.
Images land in the chat; short markdown/diffs inline; longer documents become
a card. An `.html` file becomes a full-screen interactive page.

Start from a working page: `engine/mcp/examples/` in this repo has one per
archetype (question round, task board, log viewer, metrics dashboard,
diagrams, step-through). Copy the nearest one and adapt.

## The cyc API (defined before your script runs, only inside the app)

```js
await cyc.submit({label: 'Postgres', body: anything}); // -> {ok, message}
await cyc.save(state); // -> {ok, message}
const {ok, saved, data} = await cyc.load();
cyc.close();
```

- `submit` stages what you send as an attachment on the user's composer; it
  goes to you when they press send. `label` is the chip text; `body` is a
  string or any JSON-able value. A bare argument is coerced to the body. An
  empty body refuses (`ok:false`), so always submit real content. Attachments
  survive closing the page, so submit-and-close is safe.
- `save`/`load` keep one JSON record per page ON THE ENGINE: it survives
  reloads and is the same on every device. Load first, draw from what came
  back (`saved:false` = start fresh), save debounced after every change.
  `load` answering `ok:false` means the engine could not be asked: say so on
  the page and DO NOT save, or you overwrite work that may still exist.
- Feature-detect: `typeof window.cyc !== 'undefined'`. Standalone (a plain
  browser tab) there is no bridge; the examples show a preview-mode shim.

## Hard limits, all enforced

- The page is sandboxed on an opaque origin; it cannot reach the app or the
  engine; nothing it does can read chats, storage or cookies.
- `alert` / `confirm` / `prompt` do not exist; neither do localStorage,
  cookies, IndexedDB, window.open, downloads or form submission.
- https CDNs work (scripts, styles, fonts, fetch); plain http and ws do not,
  so nothing on localhost is reachable.
- 1MB max for a page or nothing shows (2MB for other files); submit bodies
  64KB (100 per page); saved state 256KB, one record, overwritten each save.

## Theme and screen

The viewer sets `data-cyc-theme="dark|light"` on `<html>` and injects these
CSS variables: `--cyc-bg`, `--cyc-surface`, `--cyc-text`, `--cyc-muted`,
`--cyc-accent`, `--cyc-border`. Use them (with fallbacks for standalone
opening) instead of hardcoding colours, and never `@media
(prefers-color-scheme)`: that follows the OS, not the app. Canvases do not
follow CSS: watch the attribute with a MutationObserver and redraw.

Assume a phone-sized touch screen: one column, tap targets 44px+, no
hover-only affordances. Size any canvas with a ResizeObserver, never once at
startup: the page runs in an iframe written with srcdoc, and layout can land
after your script ran.
