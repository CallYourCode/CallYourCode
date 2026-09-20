export const CARD_HEARTBEAT = `(function(){
  var pending = false;
  function measure(){
    pending = false;
    var body = document.body;
    var nodes = 0;
    var text = '';
    var height = 0;
    if(body){
      function generated(node, side){
        var pseudo = getComputedStyle(node, side);
        var content = pseudo.content;
        return pseudo.display !== 'none' && pseudo.visibility !== 'hidden' &&
          content && content !== 'none' && content !== 'normal' && content !== '""';
      }
      function paints(node){
        var style = getComputedStyle(node);
        var box = node.getBoundingClientRect();
        if(style.display === 'none' || style.visibility === 'hidden' || box.width <= 0 || box.height <= 0) return false;
        var background = style.backgroundImage !== 'none' ||
          (style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)');
        var border = parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderRightWidth) > 0 ||
          parseFloat(style.borderBottomWidth) > 0 || parseFloat(style.borderLeftWidth) > 0;
        return background || border || generated(node, '::before') || generated(node, '::after');
      }
      text = typeof body.innerText === 'string' ? body.innerText.trim() : '';
      var root = document.documentElement;
      var rootStyle = getComputedStyle(root);
      var rootBorder = parseFloat(rootStyle.borderTopWidth) > 0 || parseFloat(rootStyle.borderRightWidth) > 0 ||
        parseFloat(rootStyle.borderBottomWidth) > 0 || parseFloat(rootStyle.borderLeftWidth) > 0;
      if(rootBorder || generated(root, '::before') || generated(root, '::after')) nodes++;
      var bodyStyle = getComputedStyle(body);
      var bodyBorder = parseFloat(bodyStyle.borderTopWidth) > 0 || parseFloat(bodyStyle.borderRightWidth) > 0 ||
        parseFloat(bodyStyle.borderBottomWidth) > 0 || parseFloat(bodyStyle.borderLeftWidth) > 0;
      if(bodyStyle.backgroundImage !== 'none' || bodyStyle.backgroundColor !== rootStyle.backgroundColor || bodyBorder ||
        generated(body, '::before') || generated(body, '::after')) nodes++;
      var children = body.querySelectorAll('*');
      for(var i = 0; i < children.length; i++){
        var node = children[i];
        var tag = node.tagName;
        if(tag === 'STYLE' || tag === 'SCRIPT' || tag === 'TEMPLATE' || tag === 'META' || tag === 'LINK') continue;
        var media = false;
        if(tag === 'IMG') media = node.complete && node.naturalWidth > 0 && node.naturalHeight > 0;
        else if(tag === 'VIDEO') media = node.readyState >= 2 && node.videoWidth > 0 && node.videoHeight > 0;
        else if(tag === 'SVG') media = node.querySelectorAll('*').length > 0;
        else if(tag === 'CANVAS'){
          try {
            var probe = document.createElement('canvas');
            probe.width = probe.height = 32;
            var ctx = probe.getContext('2d');
            if(ctx){
              ctx.drawImage(node, 0, 0, 32, 32);
              var pixels = ctx.getImageData(0, 0, 32, 32).data;
              for(var p = 3; p < pixels.length; p += 4){ if(pixels[p]){ media = true; break; } }
            }
          } catch(e) {}
        } else if(tag === 'INPUT') media = true;
        if(paints(node) || (media && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)) nodes++;
      }
      height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height,
        document.documentElement ? document.documentElement.scrollHeight : 0));
    }
    var nonEmpty = !!(text || nodes > 0);
    try { parent.postMessage({cycCardRender:1, nonEmpty:nonEmpty, height:height, nodes:nodes}, '*'); } catch(e) {}
  }
  function beat(){
    if(pending) return;
    pending = true;
    var done = false;
    var fallback = setTimeout(function(){ if(!done){ done = true; measure(); } }, 120);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){
      if(done) return;
      done = true;
      clearTimeout(fallback);
      measure();
    }); });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', beat);
  else beat();
  window.addEventListener('load', beat);
  window.addEventListener('pageshow', beat);
  document.addEventListener('visibilitychange', beat);
  window.addEventListener('message', function(e){
    if(e.source !== parent) return;
    if(e.data && e.data.cycCardPing) beat();
  });
  // A card is re-measured only when something that can change its paint
  // happens: a DOM change, a size change (images, fonts, wrapping), a media
  // element settling, or the parent asking (ping, reveal). There is no timer:
  // an idle card costs nothing and reports nothing.
  new MutationObserver(beat).observe(document.documentElement, {childList:true, subtree:true, characterData:true, attributes:true});
  if(typeof ResizeObserver === 'function') new ResizeObserver(beat).observe(document.documentElement);
  document.addEventListener('load', beat, true);
  document.addEventListener('error', beat, true);
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(beat, function(){});
})();`;
export const PAGE_SHIM = `(function(){
  var seq = 0, waiting = {};
  function ask(type, payload){
    return new Promise(function(resolve){
      var id = 'q' + (++seq);
      waiting[id] = resolve;
      try { parent.postMessage({cyc: 1, type: type, id: id, payload: payload}, '*'); }
      catch(e) { delete waiting[id]; resolve({ok: false, message: 'the app is not listening'}); return; }
      setTimeout(function(){
        if(!waiting[id]) return;
        delete waiting[id];
        resolve({ok: false, message: 'the app did not answer; the page may have been closed'});
      }, 35000);
    });
  }

  function said(r){ return {ok: !!r.ok, message: String(r.message || '')}; }
  window.addEventListener('message', function(e){
    if(e.source !== window.parent) return;
    var d = e.data;
    if(!d || d.cyc !== 1 || d.type !== 'cyc:ack') return;
    var done = waiting[d.id];
    if(!done) return;
    delete waiting[d.id];
    done(d);
  });

  var mem = {v: 1, author: null, drafts: {}}, memReady = false;
  function unwrap(raw){
    if(raw && typeof raw === 'object' && raw.v === 1 && raw.drafts && typeof raw.drafts === 'object') {
      return {v: 1, author: raw.author === undefined ? null : raw.author, drafts: raw.drafts};
    }
    return {v: 1, author: raw === undefined ? null : raw, drafts: {}};
  }
  function pullState(){
    return ask('cyc:load', null).then(function(r){
      if(r && r.ok) { mem = unwrap(r.data); memReady = true; }
      return r || {};
    });
  }
  function pushState(){ return ask('cyc:save', {data: JSON.stringify(mem)}); }

  window.cyc = {

    submit: function(p){
      if(p != null && (typeof p !== 'object' || Array.isArray(p))) p = {body: p};
      if(p == null || typeof p !== 'object') p = {};
      var raw = p.body, body = '', json = false;
      if(typeof raw === 'string') body = raw;
      else if(raw != null && typeof raw !== 'object') body = String(raw); // number, boolean
      else if(raw != null) { body = JSON.stringify(raw, null, 2); json = true; } // object, array

      return ask('cyc:submit', {label: String(p.label == null ? '' : p.label),
        body: body, json: json}).then(said);
    },
    close: function(){ return ask('cyc:close', null).then(said); },
    save: function(data){
      var author;

      try { author = data === undefined ? null : data; JSON.stringify(author); }
      catch(err) {
        return Promise.resolve({ok: false, message: 'that state could not be turned into ' +
          'JSON (' + err + '), so nothing was saved and nothing was sent'});
      }
      mem.author = author;
      return pushState().then(said);
    },
    load: function(){
      return pullState().then(function(r){
        return {ok: !!r.ok, saved: !!r.saved,
          data: (r && r.ok && mem.author !== undefined) ? mem.author : null,
          message: String((r && r.message) || '')};
      });
    },

    call: function(op, args){
      return ask('cyc:call', {op: String(op == null ? '' : op), args: args}).then(function(r){
        return {ok: !!r.ok, result: (r && r.ok) ? r.result : undefined,
          message: String((r && r.message) || '')};
      });
    },

    goto: function(ref){
      ref = (ref && typeof ref === 'object') ? ref : {};
      return ask('cyc:goto', {seq: ref.seq, ts: ref.ts, role: ref.role}).then(function(r){
        return {ok: !!r.ok, message: String((r && r.message) || '')};
      });
    }
  };


  function draftable(el){
    if(!el || !el.id) return false;
    var tag = el.tagName;
    if(tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
    if(tag === 'INPUT' && (el.type === 'password' || el.type === 'file' || el.type === 'hidden')) return false;
    return true;
  }
  function fieldValue(el){
    if(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? '1' : '';
    return el.value;
  }
  function fieldFill(el, v){
    if(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) el.checked = (v === '1');
    else el.value = v;
  }
  function eachField(fn){
    var all = document.querySelectorAll('input[id],textarea[id],select[id]');
    for(var i = 0; i < all.length; i++) if(draftable(all[i])) fn(all[i]);
  }
  var draftTimer = 0;
  function saveDraftsSoon(){
    if(draftTimer) return;
    draftTimer = setTimeout(function(){
      draftTimer = 0;
      var d = {};
      eachField(function(el){ d[el.id] = fieldValue(el); });
      mem.drafts = d;
      pushState();
    }, 400);
  }
  function restoreDrafts(){
    var d = mem.drafts || {};
    eachField(function(el){

      if(Object.prototype.hasOwnProperty.call(d, el.id) && !fieldValue(el)) fieldFill(el, d[el.id]);
    });
  }
  function armAutosave(){
    document.addEventListener('input', function(e){ if(draftable(e.target)) saveDraftsSoon(); }, true);
    document.addEventListener('change', function(e){ if(draftable(e.target)) saveDraftsSoon(); }, true);
  }
  function bootDrafts(){
    pullState().then(function(){
      if(!memReady) return; // load failed: restore nothing, save nothing, risk nothing
      restoreDrafts();
      armAutosave();
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootDrafts);
  else bootDrafts();
})();`;
const SUBMIT_MAX_COUNT = 100;
const SUBMIT_MAX_BODY = 64 * 1024;
const SUBMIT_MAX_TOTAL = 512 * 1024;
const SUBMIT_MAX_LABEL = 80;
const SAVE_MAX_BYTES = 256 * 1024;
export const PAGE_CSP = [
  'default-src https: data: blob:',
  "script-src https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src https: data: 'unsafe-inline'",
  'img-src https: data: blob:',
  'media-src https: data: blob:',
  'font-src https: data:',
  'connect-src https: data: blob:',
  'frame-src https: data: blob:',
  'child-src https: data: blob:',
  'worker-src https: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "manifest-src 'none'"
].join('; ');
export const PAGE_SANDBOX = 'allow-scripts';
export const SANDBOX_SHELL_URL = '/cyc-sandbox.html';
export function loadSandboxDocument(
  frame: HTMLIFrameElement,
  html: string
): {
  dispose: () => void;
} {
  const onMsg = (e: MessageEvent) => {
    if (!frame.isConnected) {
      window.removeEventListener('message', onMsg);
      return;
    }
    if (e.source !== frame.contentWindow) return;
    const m = e.data as {
      cycSandbox?: number;
      type?: string;
    } | null;
    if (!m || m.cycSandbox !== 1 || m.type !== 'ready') return;
    frame.contentWindow?.postMessage({cycSandbox: 1, type: 'doc', html}, '*');
  };
  window.addEventListener('message', onMsg);
  frame.src = SANDBOX_SHELL_URL;
  return {dispose: () => window.removeEventListener('message', onMsg)};
}
export const CARD_SANDBOX = 'allow-scripts';
export const CARD_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
type PageTheme = 'dark' | 'light';
export function themeVars(kind: 'card' | 'panel' = 'card'): {
  theme: PageTheme;
  vars: Record<string, string>;
} {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const theme: PageTheme = root.dataset.theme === 'dark' ? 'dark' : 'light';
  const dark = theme === 'dark';
  // Dark fallbacks are the app's own established surface/ground palette (the DARK
  // theme in features/settings/preferences.ts), not a foreign panel pair, for the
  // rare frame that renders before applyCycTheme has inlined the vars.
  const surface = v('--cyc-surface', dark ? '#17171a' : '#ffffff');
  const ground = v('--cyc-background-color', dark ? '#0d0d0e' : '#f6f3ec');
  return {
    theme,
    vars: {
      '--cyc-bg': kind === 'panel' ? surface : ground,
      '--cyc-surface': surface,
      '--cyc-text': v('--cyc-text', dark ? '#ffffff' : '#000000'),
      '--cyc-muted': v('--cyc-text-muted', dark ? '#a49fa8' : '#6b6b70'),
      '--cyc-accent': v('--cyc-accent', dark ? '#c98652' : '#96602f'),
      '--cyc-fill': v('--cyc-fill-color', dark ? '#a86c38' : '#96602f'),
      '--cyc-border': v('--cyc-border-color', dark ? '#000000' : '#e8e5de'),
      '--cyc-bar': dark ? '#66666c' : '#a5a2a9'
    }
  };
}
const PAGE_FONT =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ' +
  'Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif';
function baseStyle(theme: PageTheme, vars: Record<string, string>): string {
  const decls = Object.entries(vars)
    .map(([k, val]) => `${k}:${val}`)
    .join(';');
  return [
    `:root{color-scheme:${theme};${decls}}`,
    'html{background:var(--cyc-bg);color:var(--cyc-text);' +
      `font-family:${PAGE_FONT};-webkit-text-size-adjust:100%}`,
    'body{margin:0;background:var(--cyc-bg);color:var(--cyc-text)}',
    '*,*::before,*::after{box-sizing:border-box}'
  ].join('\n');
}
export function frameDocument(
  source: string,
  theme: PageTheme,
  vars: Record<string, string>
): string {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const head = doc.head ?? doc.createElement('head');
  if (!doc.head) doc.documentElement.prepend(head);
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', PAGE_CSP);
  const viewport = doc.createElement('meta');
  viewport.setAttribute('name', 'viewport');
  viewport.setAttribute('content', 'width=device-width, initial-scale=1');
  const style = doc.createElement('style');
  style.textContent = baseStyle(theme, vars);
  const shim = doc.createElement('script');
  shim.textContent = PAGE_SHIM;
  head.prepend(charset, csp, viewport, style, shim);
  doc.documentElement.setAttribute('data-cyc-theme', theme);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
function collectAppLatinFaces(): {
  weight: string;
  url: string;
}[] {
  const out = new Map<string, string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const s = rule.style;
      if (!/inter/i.test(s.getPropertyValue('font-family'))) continue;
      const range = s.getPropertyValue('unicode-range');
      if (range && !/\b0000\b/i.test(range) && !/U\+0-/i.test(range)) continue;
      const weight = s.getPropertyValue('font-weight').trim() || '400';
      const src = s.getPropertyValue('src');
      const m = src.match(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/i);
      if (m) {
        const url = new URL(m[1], document.baseURI).href;
        if (!out.has(url)) out.set(url, weight);
      }
    }
  }
  return [...out].map(([url, weight]) => ({weight, url}));
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}
let cardFontCss = '';
export const cardFontReady: Promise<void> = (async () => {
  if (typeof document === 'undefined' || typeof fetch === 'undefined') return;
  try {
    const parts: string[] = [];
    for (const f of collectAppLatinFaces()) {
      const res = await fetch(f.url);
      if (!res.ok) continue;
      const b64 = bytesToB64(new Uint8Array(await res.arrayBuffer()));
      parts.push(
        `@font-face{font-family:'Inter';font-style:normal;font-weight:${f.weight};` +
          `src:url(data:font/woff2;base64,${b64}) format('woff2')}`
      );
    }
    cardFontCss = parts.join('');
  } catch {
    cardFontCss = '';
  }
})();
function cardBaseStyle(theme: PageTheme, vars: Record<string, string>): string {
  const decls = Object.entries(vars)
    .map(([k, val]) => `${k}:${val}`)
    .join(';');
  const font = cardFontCss ? `'Inter', ${PAGE_FONT}` : PAGE_FONT;
  const plate = 'color-mix(in srgb, var(--cyc-muted) 16%, var(--cyc-surface))';
  return [
    cardFontCss,
    `:root{color-scheme:${theme};${decls}}`,
    `html{background:${plate};color:var(--cyc-text);font-family:${font};-webkit-text-size-adjust:100%}`,
    `body{margin:0;background:${plate};color:var(--cyc-text)}`,
    '*,*::before,*::after{box-sizing:border-box}'
  ].join('\n');
}
export function cardDocument(
  fragment: string,
  theme: PageTheme,
  vars: Record<string, string>
): string {
  return (
    '<!doctype html><html data-cyc-theme="' +
    theme +
    '"><head>' +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    cardBaseStyle(theme, vars) +
    '</style>' +
    '<script>' +
    CARD_HEARTBEAT +
    '</script>' +
    '</head><body>' +
    fragment +
    '</body></html>'
  );
}
type SandboxSubmit = {
  label: string;
  body: string;
  json: boolean;
};
type SandboxHandlers = {
  onSubmit?: (p: SandboxSubmit) => {
    ok: boolean;
    message: string;
  };
  onEmptySubmit?: () => void;
  onClose?: () => void;
  onSave?: (state: string) => Promise<{
    ok: boolean;
    message: string;
  }>;
  onLoad?: () => Promise<{
    ok: boolean;
    saved: boolean;
    data: unknown;
    message: string;
  }>;
  onCall?: (
    op: string,
    args: unknown
  ) => Promise<{
    ok: boolean;
    result?: unknown;
    message?: string;
  }>;
  onGoto?: (ref: {seq?: number; ts: number; role: 'user' | 'claude'}) => Promise<{
    ok: boolean;
    message?: string;
  }>;
};
export function installSandboxBridge(
  getFrame: () => HTMLIFrameElement | null,
  handlers: SandboxHandlers
): {
  uninstall: () => void;
} {
  let submitted = 0;
  let submittedBytes = 0;
  const onMessage = (e: MessageEvent) => {
    const frame = getFrame();
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data as {
      cyc?: number;
      type?: string;
      id?: string;
      payload?: {
        label?: string;
        body?: string;
        json?: boolean;
        data?: string;
        op?: string;
        args?: unknown;
        seq?: number;
        ts?: number;
        role?: string;
      };
    } | null;
    if (!d || d.cyc !== 1 || typeof d.type !== 'string') return;
    const ack = (ok: boolean, message: string, extra: Record<string, unknown> = {}) => {
      if (typeof d.id !== 'string') return;
      frame.contentWindow?.postMessage(
        {cyc: 1, type: 'cyc:ack', id: d.id, ok, message, ...extra},
        '*'
      );
    };
    if (d.type === 'cyc:close') {
      ack(true, 'closing');
      handlers.onClose?.();
      return;
    }
    if (d.type === 'cyc:save') {
      const state = typeof d.payload?.data === 'string' ? d.payload.data : '';
      if (!state) return ack(false, 'the save carried no state, so nothing was saved');
      const bytes = new Blob([state]).size;
      if (bytes > SAVE_MAX_BYTES) {
        return ack(
          false,
          `that state is ${Math.round(bytes / 1024)}KB and the limit is ` +
            `${SAVE_MAX_BYTES / 1024}KB, so nothing was saved and nothing was sent. ` +
            'Whatever was saved before is still there.'
        );
      }
      if (!handlers.onSave) return ack(false, 'this page cannot save here, so nothing was saved');
      void handlers.onSave(state).then((r) => ack(r.ok, r.message));
      return;
    }
    if (d.type === 'cyc:load') {
      if (!handlers.onLoad)
        return ack(false, 'this page cannot load here', {saved: false, data: null});
      void handlers.onLoad().then((r) => ack(r.ok, r.message, {saved: r.saved, data: r.data}));
      return;
    }
    if (d.type === 'cyc:call') {
      if (!handlers.onCall) return ack(false, 'this page cannot call here');
      const op = typeof d.payload?.op === 'string' ? d.payload.op : '';
      void handlers
        .onCall(op, d.payload?.args)
        .then((r) =>
          ack(r.ok, typeof r.message === 'string' ? r.message : '', r.ok ? {result: r.result} : {})
        );
      return;
    }
    if (d.type === 'cyc:goto') {
      if (!handlers.onGoto) return ack(false, 'this page cannot navigate the conversation');
      const ts = Number(d.payload?.ts);
      const role = d.payload?.role as 'user' | 'claude' | undefined;
      if (!Number.isFinite(ts) || (role !== 'user' && role !== 'claude')) {
        return ack(false, 'the goto had no valid {ts, role}, so nothing was navigated');
      }
      const seqRaw = Number(d.payload?.seq);
      const ref = {ts, role, ...(Number.isFinite(seqRaw) ? {seq: seqRaw} : {})};
      void handlers
        .onGoto(ref)
        .then((r) => ack(r.ok, typeof r.message === 'string' ? r.message : ''));
      return;
    }
    if (d.type !== 'cyc:submit') return;
    if (!handlers.onSubmit)
      return ack(
        false,
        'this page was opened somewhere that cannot ' + 'take an attachment, so nothing was staged'
      );
    const body = typeof d.payload?.body === 'string' ? d.payload.body : '';
    const said = String(d.payload?.label ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const label = said.slice(0, SUBMIT_MAX_LABEL) || 'Answer';
    if (!body) {
      handlers.onEmptySubmit?.();
      return ack(false, 'the submission had an empty body, so nothing was staged');
    }
    const bytes = new Blob([body]).size;
    if (bytes > SUBMIT_MAX_BODY) {
      return ack(
        false,
        `that submission is ${Math.round(bytes / 1024)}KB and the limit is ` +
          `${SUBMIT_MAX_BODY / 1024}KB, so nothing was staged`
      );
    }
    if (submitted >= SUBMIT_MAX_COUNT) {
      return ack(
        false,
        `${SUBMIT_MAX_COUNT} submissions from one page is the limit, so ` +
          'nothing was staged. Close and reopen the page to start again.'
      );
    }
    if (submittedBytes + bytes > SUBMIT_MAX_TOTAL) {
      return ack(
        false,
        `this page has already sent ${Math.round(submittedBytes / 1024)}KB and ` +
          `the limit is ${SUBMIT_MAX_TOTAL / 1024}KB, so nothing was staged`
      );
    }
    const r = handlers.onSubmit({label, body, json: !!d.payload?.json});
    if (r.ok) {
      submitted++;
      submittedBytes += bytes;
    }
    ack(r.ok, r.message);
  };
  window.addEventListener('message', onMessage);
  return {uninstall: () => window.removeEventListener('message', onMessage)};
}
