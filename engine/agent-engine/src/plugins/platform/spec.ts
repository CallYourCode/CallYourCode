/* THE PLUGIN SPEC, A PURE LEAF (blueprint plugin-selfcontain, Move 1).
 *
 * The SHAPE a plugin is written in (PluginSpec), the shape that crosses the wire
 * (PluginDecl), the rpc ctx, the composer widget decl and the section-3 caps.
 * Extracted from the registry so a plugin file can import the vocabulary
 * it is written in WITHOUT importing the registry that lists every plugin -- that
 * back-edge was the one true runtime cycle (registry.ts <-> reply-dials.ts, and
 * through it every plugin). This file imports nothing engine-side: it is the leaf
 * both plugins/* and registry.ts sit above.
 *
 * registry.ts keeps the registry half (pluginDecl, declarePlugins, loadPlugins).
 */

/* ---- the id, spelled in one place ------------------------------------------
 *
 * Lowercase, digits, dashes, 1..64. It is a URL path segment (/plugin/<id>/...)
 * and a toolbar namespace (plugin:<engine>:<id>), so it may hold nothing that
 * would need escaping in either. A spec whose id does not match is DROPPED from
 * the loaded list with a line, not coerced: a coerced id is an id two different
 * pieces of code compute differently, which is the drift the tabs file warns
 * about. */
export const PLUGIN_ID_RE = /^[a-z0-9-]{1,64}$/;

/* ---- the surfaces, and the caps each one's payload is held to ---------------
 *
 * These are the section-3 budgets, written where the code that enforces them
 * can import them rather than spelled again per call site. */
export const CARD_HTML_MAX_BYTES = 128 * 1024; // a card is HTML+CSS, no scripts
export const PANEL_HTML_MAX_BYTES = 1024 * 1024; // same cap as a shown page
export const RPC_ARGS_MAX_BYTES = 256 * 1024; // body in
/* THE ONE REPLY CAP, RAISED 1 MB -> 16 MB (arch section 3.3). git and files are
 * sandboxed-HTML plugins now, so a whole diff or file body comes back in ONE
 * cyc.call rather than over a native HTTP route. 16 MB is sized to what a reply
 * actually carries: a big realistic diff (a lockfile rewrite, a generated-code
 * sweep) is low single-digit MB of raw text, JSON string-escaping roughly
 * doubles it, and pre-highlighted HTML markup adds another 2-3x, so ~8 MB is
 * reachable by honest content while 16 MB is not, in practice, by anything but
 * abuse. It is still a hard bound a phone can buffer in one piece. One cap, no
 * per-plugin carve-out; args stay 256 KB and the html caps are unchanged.
 * routes/plugin.ts enforces this constant on the reply; an over-cap reply is
 * refused with the same honest 413 sentence as today.
 *
 * TRANSPORT NOTE, settled (contracts FINDINGS #5). Plugin rpc rides the sealed
 * DataChannel now, and a reply NEVER rides one frame: tunnel-glue's reply()
 * streams every Response body through ResStreamEncoder, which carves it into
 * CHUNK (256 KB) frames (transport/tunnel.ts), each ~350 KB sealed, far below
 * dcpipe MSG_MAX (16 MB); the app reassembles the multi-frame answer as a
 * stream with no ceiling (tunnelClient.ts onRes). So a reply AT this cap
 * transits, and the cap stands. Proven hermetically by the rpc-cap cases in
 * transport/tunnel-glue.test.ts. */
export const RPC_REPLY_MAX_BYTES = 16 * 1024 * 1024; // json out

/* The floor under a card's refresh, both sides. Five seconds so a page cannot
 * turn the refresh button into a poll; a decl asking for less is clamped UP,
 * never refused, because a too-eager number is a mistake to correct, not a
 * plugin to drop. */
export const CARD_REFRESH_FLOOR_MIN_S = 5;

/* How long a hook may take before the request that called it is answered with
 * an error instead. render is cheap (it reads a cached number); rpc/html may
 * touch the filesystem. A hook that overruns answers THAT ONE request badly and
 * touches no core state -- there is no disable-after-N machinery, because
 * nothing yet produces the failure that would need it. */
export const RENDER_TIMEOUT_MS = 2_000;
export const HOOK_TIMEOUT_MS = 10_000;

/* THE USAGE CARD'S RENDER GOES UPSTREAM ON A FORCE, so it needs longer than the
 * generic 2 s (#577 section 3). A plain poll reads the cached number and is
 * quick; a forced refresh (`?refresh=1`) makes limitsNow(true) fetch usage and
 * profile, up to two 10 s requests. These two numbers are the SAME budgets the
 * app's own AbortSignal uses (store.ts pluginCardOf: 8 s poll / 12 s refresh),
 * so both ends agree on when a card is late. Other renders keep RENDER_TIMEOUT_MS. */
export const CARD_RENDER_TIMEOUT_MS = { poll: 8_000, refresh: 12_000 } as const;

/* ---- a composer widget, declarative only -----------------------------------
 *
 * His rule for the composer surface: sliders / prompt-bits / attachment-menu
 * class of things, data in and data out, NO free rein. So a composer extra is a
 * DECLARATION the app renders with its own components (contextMenu, the reply
 * dial), never plugin HTML or JS. Two types in v1; a third is a new member
 * here, not a new transport. */
export type ComposerWidgetDecl =
  | {
      type: "menu";
      icon: string;
      label: string;
      /* which widget this is, engine-local (WIDGET_KEY_RE). OPTIONAL on a menu:
       * a menu inserts text app-side and needs no round-trip, so a key is only a
       * label the app namespaces, never required. */
      key?: string;
      /* prompt-bits-shaped: each item inserts its text at the caret, app-side,
       * exactly as GlobalSettings.strings.bits do today. */
      items: { text: string; insert: string }[];
    }
  | {
      type: "slider";
      icon: string;
      label: string;
      /* REQUIRED on a slider (WIDGET_KEY_RE): the chosen step is POSTed as
       * /plugin/<id>/rpc/set {key, n}, so the engine plugin knows WHICH dial
       * moved. A slider with no key is dropped -- it could not say what it set. */
      key: string;
      /* the step the dial currently points at. When present it must equal one of
       * steps[].n, else the widget is dropped: a dial pointing at a rung it does
       * not have is not the dial the plugin declared. Lets the app draw the rail
       * from the decl alone, no state fetch. */
      value?: number;
      /* dial-shaped: the chosen step's n is POSTed to /plugin/<id>/rpc/set and
       * what the engine does with it is engine-side plugin code (the way reply
       * dials append an instruction at delivery). */
      steps: { n: number; name: string; hint?: string }[];
    };

/* The caps on a composer decl, from section 3. Over any of them the widget is
 * DROPPED (logged), never truncated: a menu with half its items or a slider
 * with the wrong number of steps is a widget that does something other than
 * what the plugin declared. */
export const MENU_MAX_ITEMS = 24;
export const MENU_ITEM_TEXT_MAX = 200;
export const SLIDER_MAX_STEPS = 9;
/* A composer widget's `key` (which dial): a URL/rpc-safe segment the app
 * namespaces against the engine. Same alphabet as an rpc op name, so the pair
 * {key, n} the slider POSTs is spellable in the one /plugin/<id>/rpc/set route. */
export const WIDGET_KEY_RE = /^[a-z0-9_-]{1,32}$/;

/* ---- what a plugin IS, engine-side (functions live here, never on the wire) --
 *
 * THE SURFACE SET COVERS EVERY BOLT-ON (his scope note, 2026-08-14). One
 * registry, one wire contract, and every one of today's hand-built extras is a
 * plugin surface:
 *
 *   card      an engine-rendered HTML face in a no-token frame  (usage card)
 *   panel     a toolbar entry that opens a sandboxed page        (crons, git, files)
 *   action    a toolbar BUTTON with no page: tap fires an rpc,
 *             an optional badge rpc supplies a live chip         (stop, ctx)
 *   composer  a declarative menu/slider extra                    (prompt bits, verbosity, complexity)
 *   tui       a toolbar entry that opens the terminal viewer on
 *             the session's own pane (term-* frames)             (terminal)
 *
 * rpc is PLUGIN-LEVEL, not nested under panel: every surface reaches the engine
 * over the one /plugin/<id>/rpc/<op> route, so an action with no panel (stop) or
 * an indicator (ctx) can call the engine exactly as a panel page does. Migration
 * order stays as the brief names it (usage card, then crons); the others are
 * declarable now and migrated in their own sized steps. */
export type PluginSpec = {
  id: string; // PLUGIN_ID_RE
  name: string; // what a person reads
  version: number;
  card?: {
    title: string;
    refreshFloorS: number; // >= CARD_REFRESH_FLOOR_MIN_S, clamped up if lower
    /* opaque; the app keeps the newest card per key across hosts. Engine-side
     * only: the usage card returns an account hash so one account shows one
     * card wherever it is signed in. */
    dedupe?: () => string | null;
    /* html is the card FACE (the app frames it, no chrome); ageMs dates it; height
     * is the exact CSS px the face needs. A no-JS frame cannot size itself, so the
     * card that knows how many rows it drew names its own height and the app frames
     * it to that -- the alternative is a fixed clamp that clips or leaves a gap
     * (#479 parity: the fixed 150px clamp was the card's dead whitespace).
     *
     * `force` is the refresh arrow, threaded through: a plain poll renders from
     * the cached reading, a forced refresh (the button, `?refresh=1` past the
     * floor) tells the card to re-derive its data from source. Without it the
     * usage card's render read the cache unconditionally, so the refresh button
     * re-fetched the SAME account's stale numbers and looked dead (#570). */
    render: (opts?: { force?: boolean }) => Promise<{ html: string; ageMs: number | null; height?: number;
      /* WHY the numbers are old, for the app's age line (#577). Only the usage
       * card sets these; the app turns `stale` into "(retrying)" and `throttled`
       * into "(check throttled)" and dims the face. Absent means neither. */
      stale?: boolean; throttled?: boolean }>;
  };
  panel?: {
    icon: string; // a built-in icon name, or a single emoji glyph
    label: string; // toolbar text label (icon + label, his rule)
    needsSession: boolean; // the app resolves and passes the session id
    html: () => Promise<string>; // <= PANEL_HTML_MAX_BYTES
    /* the rpc ops this panel's page may call via cyc.call. The app validates an
     * op against this list before it fetches (defence in depth; the engine 404s
     * an unknown op regardless). Omitted or empty means the page calls nothing. */
    ops?: string[];
    /* an rpc op the app polls (refresh-floored) for a short live chip on this
     * panel's toolbar button -- the badge an `action` surface carries (ctx -> a
     * context %), on a panel that also opens a page on tap. The model indicator
     * (#581) is the shape: tap opens the panel, and the button meanwhile wears the
     * model acronym its badge op reports. Names an op in `rpc` below; omitted
     * means the button carries its label alone. */
    badge?: string;
    /* how the panel seats in the app (#530): 'side' docks it as a right-column
     * card (full-screen on the phone), 'full' (default) is the full-bleed
     * overlay, 'page' is a CHROMELESS full-bleed overlay -- no paneHeader, the
     * iframe alone at the native git/files overlay geometry (inset 0, z-index 11).
     * git and files use 'page' because their pages draw their own head bar and a
     * dock header would be a second one. Passed straight through to the decl. */
    dock?: "full" | "side" | "page";
    /* #574: whether this surface's toolbar entry is SHOWN by default on a device
     * that has no stored show/hide pref for it. The app keeps a per-device
     * default per toolbar action (lib/toolbarActions defaultShown); a plugin that
     * declares this REPLACES that default for its own entry -- true = shown on
     * every device by default, false = hidden until the user pins it. Omitted =
     * the app's device-class default stands. A stored user choice always wins.
     * Carried on the wire; a non-boolean is dropped (the default stands). */
    toolbarDefault?: boolean;
  };
  action?: {
    icon: string;
    label: string;
    needsSession: boolean;
    /* the rpc op fired when the button is tapped (stop -> "stop"). Names an op
     * in `rpc` below; the app calls /plugin/<id>/rpc/<run> with the session. */
    run?: string;
    /* an rpc op the app polls (refresh-floored) for a short live chip on the
     * button (ctx -> a context %). Names an op in `rpc` below. */
    badge?: string;
    toolbarDefault?: boolean; // #574, see panel.toolbarDefault above
    /* App-owned confirm chrome. The plugin may set only label + message.
     * Cancel is the app's and is not a field; extra keys are stripped in
     * pluginDecl so a remapped Escape cannot ride the wire. */
    confirm?: { label: string; message: string };
  };
  /* declarative only. A FUNCTION when the widgets are built live from engine
   * state (the reply dials rebuild their steps and `value` on every change);
   * pluginDecl calls it in try/catch, so a throwing composer drops only this
   * surface, never the plugin. A plain array for a static widget set. */
  composer?: ComposerWidgetDecl[] | (() => ComposerWidgetDecl[]);
  tui?: {
    icon: string;
    label: string;
    /* NO `command` (#590). A terminal opens on the SESSION's own pane over the
     * existing term-* ws frames (server.ts term handlers); nothing engine-side
     * ever spawned a tui.command, so the field was two answers to one question
     * with no caller. Spawn-a-command terminals are a future surface, added back
     * when something implements them. */
    toolbarDefault?: boolean; // #574, see panel.toolbarDefault above
  };
  /* PLUGIN-LEVEL rpc: reached over /plugin/<id>/rpc/<op> by whatever surface
   * needs data (a panel page via cyc.call, an action button, a badge poll).
   * The route builds the ctx: `session` is what the app attached, `agent` is
   * the stable agent id the engine resolved for it (H2) so a data-owning
   * plugin can key its records without a session fact seam. */
  rpc?: Record<string, (ctx: RpcCtx, args: unknown) => Promise<unknown>>;
  /* PER-OP RPC DEADLINE OVERRIDE, engine-side only (never on the wire). The
   * generic rpc hook deadline is HOOK_TIMEOUT_MS (10 s); a few ops need longer
   * because the native route they replaced had a wider transport budget -- a
   * cold `git status` or a 50k-entry listDir that succeeds today must still
   * succeed. Keyed by op name; an op not named keeps the generic deadline. Same
   * precedent as CARD_RENDER_TIMEOUT_MS's split. routes/plugin.ts reads it. */
  rpcTimeoutMs?: Record<string, number>;
  /* Test plumbing, not a capability: a plugin that runs its own loop (crons)
   * stops it here so a test can load and unload plugins without leaking
   * timers. Never called on the wire; the composition root calls it only on
   * shutdown paths and tests. */
  dispose?: () => void;
};

/* THE FS/GIT OP DEADLINE (3.4.4): git and files rpc ops delegate to the files.ts
 * verbs, whose native HTTP routes had a 20 s transport backstop. The generic
 * 10 s hook deadline is too tight for a cold first `git status` on a large repo
 * or a listDir over tens of thousands of entries, so those ops carry this wider
 * budget via PluginSpec.rpcTimeoutMs. */
export const FSGIT_OP_TIMEOUT_MS = 20_000;

/** Who is calling an rpc op: the session the app attached (or null), and the
 *  stable agent id the engine resolved for that session (or null). */
export type RpcCtx = { session: string | null; agent: string | null };

/* ---- what crosses the wire: the SAME fields, minus every function ---------- */
export type PluginDecl = {
  id: string;
  name: string;
  version: number;
  card?: { title: string; refreshFloorS: number };
  panel?: { icon: string; label: string; needsSession: boolean; ops?: string[]; dock?: "full" | "side" | "page"; badge?: string; toolbarDefault?: boolean };
  action?: { icon: string; label: string; needsSession: boolean; run?: string; badge?: string; toolbarDefault?: boolean; confirm?: { label: string; message: string } };
  composer?: ComposerWidgetDecl[];
  tui?: { icon: string; label: string; toolbarDefault?: boolean };
};
