/* THE VOICE SELECTOR AS A PANEL PLUGIN (#558): the per-session voice choice,
 * moved out of the core profile pane and onto the plugin surface.
 *
 * His ask: "removing this extra voice option from the core product and having a
 * separate voice plugin." Only the SELECTOR moves. Playback, speed, autoplay and
 * recording stay core -- this plugin is the one control that picks which TTS
 * voice a session speaks in.
 *
 * The engine already owns the session voice entirely (server.ts voiceOverrides +
 * the /voices and /session/<id>/voice routes). This plugin does NOT re-implement
 * any of that: its rpc ops are a thin skin over the SAME functions those routes
 * use -- injected as `deps` so there is one store of the choice, not two -- and
 * its panel renders that state and mutates it through cyc.call. The session id is
 * attached by the APP on every call (needsSession); the page never asserts which
 * session it is, it only sets the voice it is handed.
 *
 * WHAT STAYS BEHIND IT: the engine HTTP routes keep working (other clients and
 * the app-server sampling flow use them); this panel is a second caller of the
 * same seam, not a replacement for the wire.
 *
 *   bun test agent-engine/src/plugins/persona/persona.test.ts
 */

import type { PluginSpec } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";

/* THE VOICE PANEL, over the typed PluginCore. Every
 * read and write goes through `core.tts`: list/sample are the TTS engine;
 * voiceOf/setVoice/globalDefault/setDefault are the per-session choice and host
 * default (the SAME session-state the /voices and /session/<id>/voice routes use,
 * so core's own voiceFor still resolves the voice). No data moved. sessionExists
 * is the panel's session guard, and it runs BEFORE any write so a stale panel's
 * host-wide setDefault cannot repoint every conversation. */

export function personaPlugin(core?: (id: string) => PluginCore): PluginSpec {
  const svc = (): PluginCore["tts"] => {
    if (!core) throw new Error("persona is not wired on this engine");
    return core("persona").tts;
  };
  const requireSession = (session: string | null): string => {
    if (!session) throw new Error("this panel needs a session");
    if (!svc().sessionExists(session)) throw new Error("no such session");
    return session;
  };

  return {
    /* The wire id is "persona" (the /plugin/persona/* routes, the app's toolbar
     * action id and stored show/hide key all name it), and what a PERSON reads is
     * Persona too (#574): the button reused the autoplay speaker and read like a
     * second volume control. A person glyph and the word Persona say what it is --
     * which of the host's TTS personas speaks this conversation. */
    id: "persona",
    name: "Persona",
    version: 1,
    panel: {
      icon: "user", // the person glyph (#574), not the speaker it shared with autoplay
      label: "Persona",
      needsSession: true, // the app attaches the session id to every rpc call
      dock: "side", // a small right-column card (full-screen on the phone)
      toolbarDefault: false, // his call 2026-08-17: not shown by default, pin to show
      html: async () => VOICE_HTML,
      ops: ["list", "set", "sample", "set-default"],
    },
    rpc: {
      /* list(session) -> {voices, current, default}. The host's voices, the
       * session's override ('' when it is on the default), and the default the
       * override falls back to. */
      list: async ({ session }) => {
        const id = requireSession(session);
        const t = svc();
        return {
          voices: await t.list(),
          current: t.voiceOf(id),
          default: t.globalDefault(),
        };
      },
      /* set(session, {voice}) -> {current}. An empty voice clears the override,
       * exactly as POST /session/<id>/voice does. */
      set: async ({ session }, args) => {
        const id = requireSession(session);
        const t = svc();
        const a = (args ?? {}) as Record<string, unknown>;
        const voice = typeof a.voice === "string" ? a.voice.trim() : "";
        t.setVoice(id, voice);
        return { current: t.voiceOf(id) };
      },
      /* set-default(session, {voice}) -> {default}. The HOST default every
       * session without an override falls back to (#584). '' clears it. The
       * session is required only because the panel is session-scoped; the value
       * it sets is host-wide. */
      "set-default": async ({ session }, args) => {
        requireSession(session);
        const t = svc();
        const a = (args ?? {}) as Record<string, unknown>;
        const voice = typeof a.voice === "string" ? a.voice.trim() : "";
        t.setDefault(voice);
        return { default: t.globalDefault() };
      },
      /* sample(session, {voice}) -> {audio}. A short line spoken in the voice,
       * base64 mp3, so the sandboxed page can play it from a data URL without a
       * network of its own. null audio = the voice engine could not render it. */
      sample: async ({ session }, args) => {
        requireSession(session);
        const t = svc();
        const a = (args ?? {}) as Record<string, unknown>;
        const voice = typeof a.voice === "string" ? a.voice.trim() : "";
        return { audio: await t.sample(voice) };
      },
    },
  };
}

/* THE PANEL PAGE. Self-contained HTML+CSS+JS, run in the show sandbox (no network
 * of its own; every read, write and sample is a cyc.call the app performs against
 * this engine). Plain ES so it runs anywhere the sandbox does. It uses the app's
 * --cyc-* theme vars (frameDocument injects them), so it reads the same in day and
 * night as the rest of the app. A sample plays from a data: URL the rpc returns,
 * because the sandbox has no origin to fetch one from. */
const VOICE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Persona</title>
<style>
  body{margin:0;padding:12px;font-size:14px;color:var(--cyc-text)}
  h1{font-size:15px;margin:0 0 4px}
  .intro{color:var(--cyc-muted);font-size:12px;margin:0 0 12px}
  ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  li{border:1px solid var(--cyc-border);border-radius:9px;padding:4px;
    display:flex;align-items:center;gap:4px;transition:border-color .15s,background .15s}
  li:hover,li:focus-within{border-color:var(--cyc-muted)}
  li.on{border-color:var(--cyc-accent);background:var(--cyc-surface)}
  li.pending{opacity:.72}
  .pick{color:inherit;border-radius:6px;padding:4px;display:flex;align-items:center;gap:8px;
    flex:1;min-width:0;text-align:left}
  button.pick{font:inherit;background:transparent;border:0;cursor:pointer}
  button.pick:hover,button.pick:focus-visible{background:var(--cyc-surface)}
  button.pick:focus-visible{outline:2px solid var(--cyc-accent);outline-offset:1px}
  button.pick:active{transform:scale(.99);background:var(--cyc-border)}
  li.pending button.pick{cursor:wait}
  li .meta{flex:1;min-width:0}
  li .name-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  li .name{font-weight:600;overflow:hidden;text-overflow:ellipsis}
  li .sub{color:var(--cyc-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis}
  .tick{color:var(--cyc-accent);font-weight:700;width:16px;text-align:center;flex:none}
  .badge{border:1px solid var(--cyc-border);border-radius:999px;padding:1px 6px;
    color:var(--cyc-muted);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
  .badge.used{border-color:var(--cyc-accent);color:var(--cyc-accent)}
  .actions{display:flex;align-items:center;gap:4px;flex:none}
  button.control{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:7px;
    min-height:30px;background:transparent;color:var(--cyc-muted);position:relative;
    transition:background .15s,border-color .15s,color .15s,transform .08s,opacity .15s}
  button.control:hover,button.control:focus-visible{background:var(--cyc-surface);border-color:var(--cyc-border);color:var(--cyc-text)}
  button.control:focus-visible{outline:2px solid var(--cyc-accent);outline-offset:1px}
  button.control:active:not(:disabled){transform:scale(.9);background:var(--cyc-border)}
  button.control:disabled{cursor:default}
  button.play{width:32px;padding:3px;font-size:13px;color:var(--cyc-text)}
  button.play.loading{cursor:wait;color:transparent;border-color:var(--cyc-accent);background:var(--cyc-surface)}
  button.play.loading:after{content:'';position:absolute;inset:0;margin:auto;width:12px;height:12px;
    border:2px solid var(--cyc-border);border-top-color:var(--cyc-accent);border-radius:50%;animation:spin .7s linear infinite}
  button.make-default{padding:3px 7px;font-size:11px;opacity:0;pointer-events:none}
  li:hover button.make-default,li:focus-within button.make-default,li.on button.make-default,
  li.is-default button.make-default{opacity:1;pointer-events:auto}
  button.make-default:disabled{color:var(--cyc-accent);opacity:1}
  button.make-default.loading{cursor:wait;opacity:1}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (hover:none),(pointer:coarse){button.make-default{opacity:1;pointer-events:auto}}
  @media (prefers-reduced-motion:reduce){li,button.control,button.pick{transition:none}button.play.loading:after{animation-duration:1.4s}}
  .err{color:#c0392b;font-size:12px;min-height:16px;margin-top:8px}
  .empty{color:var(--cyc-muted);font-size:13px}
</style></head>
<body>
  <h1>Persona</h1>
  <p class="intro">How this conversation is read out. Tap a voice to use it here; play to hear it first; Default makes it this host\u2019s voice for every conversation without its own.</p>
  <ul id="list"></ul>
  <p class="empty" id="empty" hidden>This host reports no voices.</p>
  <div class="err" id="err" role="status" aria-live="polite"></div>
<script>
(function(){
  var cyc = window.cyc;
  var mutation = 0;
  var mutationQueue = Promise.resolve();
  var $ = function(id){ return document.getElementById(id); };
  function err(m){ $('err').textContent = m || ''; }

  // kokoro ids like "af_heart" -> "Af Heart": readable without copying the app's
  // curated voice table into the engine. The picker lists whatever the host says.
  function pretty(id){
    return id.replace(/_/g, ' ').replace(/\\b\\w/g, function(c){ return c.toUpperCase(); });
  }

  function buttonBusy(button, busy, label){
    if(!button) return;
    button.disabled = busy;
    button.classList.toggle('loading', busy);
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    if(label) button.setAttribute('aria-label', label);
  }

  function play(b64){
    return new Promise(function(resolve){
      if(!b64){ err('no sample for that voice'); resolve(); return; }
      try {
        var audio = new Audio('data:audio/mpeg;base64,' + b64);
        var done = false;
        var finish = function(message){
          if(done) return;
          done = true;
          if(message) err(message);
          resolve();
        };
        audio.addEventListener('ended', function(){ finish(); });
        audio.addEventListener('error', function(){ finish('could not play the sample'); });
        var started = audio.play();
        if(started && started.catch) started.catch(function(){ finish('audio playback was blocked'); });
      } catch(e){ err('audio playback was blocked'); resolve(); }
    });
  }

  function sample(voice, button){
    err('');
    buttonBusy(button, true, 'Playing sample');
    return cyc.call('sample', {voice: voice}).then(function(r){
      if(r && r.ok && r.result) return play(r.result.audio);
      err((r && r.message) || 'could not play a sample');
    }, function(){ err('could not play a sample'); }).then(function(){
      buttonBusy(button, false, button && button._label ? button._label : 'Play sample');
    });
  }

  function rowBusy(row, busy){
    if(!row) return;
    row.classList.toggle('pending', busy);
    if(busy) row.setAttribute('aria-busy', 'true');
    else row.removeAttribute('aria-busy');
  }

  // Keep writes in click order. The token suppresses stale redraws while the
  // queue guarantees that the newest click is also the newest engine value.
  function enqueueMutation(work){
    var next = mutationQueue.then(work, work);
    mutationQueue = next.then(function(){}, function(){});
    return next;
  }

  // After a set / set-default settles, the newest click re-reads the engine so
  // Used here / Default match the actual value even when that last write failed.
  // Older tokens only drop their pending state.
  function reconcile(token, restore){
    if(token !== mutation){ restore(); return Promise.resolve(false); }
    return refresh(token).then(function(drawn){
      if(!drawn) restore();
      return !!drawn;
    }, function(){ restore(); return false; });
  }

  function set(voice, row){
    var token = ++mutation;
    err('');
    rowBusy(row, true);
    return enqueueMutation(function(){ return cyc.call('set', {voice: voice}); }).then(function(r){
      var ok = !!(r && r.ok);
      if(!ok && token === mutation) err((r && r.message) || 'could not set the voice');
      return reconcile(token, function(){ rowBusy(row, false); }).then(function(drawn){
        if(!drawn || !ok || token !== mutation) return;
        var buttons = $('list').querySelectorAll('button.play');
        var button = null;
        for(var i = 0; i < buttons.length; i++) if(buttons[i]._voice === voice) button = buttons[i];
        return sample(voice, button);
      });
    }, function(){
      if(token === mutation) err('could not set the voice');
      return reconcile(token, function(){ rowBusy(row, false); });
    });
  }

  // #584: the host default, set from here (the app's Settings row is gone)
  function setDefault(voice, button){
    var token = ++mutation;
    err('');
    buttonBusy(button, true, 'Setting host default');
    var restore = function(){ buttonBusy(button, false, button && button._label ? button._label : 'Set as host default'); };
    return enqueueMutation(function(){ return cyc.call('set-default', {voice: voice}); }).then(function(r){
      if(!(r && r.ok) && token === mutation) err((r && r.message) || 'could not set the default');
      return reconcile(token, restore);
    }, function(){
      if(token === mutation) err('could not set the default');
      return reconcile(token, restore);
    });
  }

  function rowFor(opts){
    var li = document.createElement('li');
    if(opts.on) li.classList.add('on');
    if(opts.isDefault) li.classList.add('is-default');
    var pick = document.createElement(opts.onPick ? 'button' : 'div'); pick.className = 'pick';
    if(opts.onPick){
      pick.type = 'button';
      pick.setAttribute('aria-label', 'Use ' + opts.name + ' for this conversation');
      pick.setAttribute('aria-pressed', opts.on ? 'true' : 'false');
    }
    var tick = document.createElement('span'); tick.className = 'tick';
    tick.textContent = opts.on ? '\\u2713' : '';
    tick.setAttribute('aria-hidden', 'true');
    var meta = document.createElement('div'); meta.className = 'meta';
    var nameLine = document.createElement('div'); nameLine.className = 'name-line';
    var name = document.createElement('span'); name.className = 'name'; name.textContent = opts.name;
    nameLine.appendChild(name);
    if(opts.on){ var used = document.createElement('span'); used.className = 'badge used'; used.textContent = 'Used here'; nameLine.appendChild(used); }
    if(opts.isDefault){ var host = document.createElement('span'); host.className = 'badge'; host.textContent = 'Host default'; nameLine.appendChild(host); }
    meta.appendChild(nameLine);
    if(opts.sub){ var sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = opts.sub; meta.appendChild(sub); }
    pick.appendChild(tick); pick.appendChild(meta);
    if(opts.onPick) pick.addEventListener('click', function(){ opts.onPick(li); });
    li.appendChild(pick);
    var actions = document.createElement('div'); actions.className = 'actions';
    if(opts.sampleVoice != null){
      var b = document.createElement('button'); b.className = 'control play'; b.textContent = '\u25b6';
      b.title = 'Play sample'; b._label = 'Play sample for ' + opts.name; b.setAttribute('aria-label', b._label); b._voice = opts.sampleVoice;
      b.addEventListener('click', function(ev){ ev.stopPropagation(); sample(opts.sampleVoice, b); });
      actions.appendChild(b);
    }
    if(opts.defaultVoice != null){
      var d = document.createElement('button'); d.className = 'control make-default';
      d.textContent = opts.isDefault ? 'Default \u2713' : 'Set default';
      d.disabled = !!opts.isDefault;
      d.title = opts.isDefault ? 'This is the host default' : 'Make this the host default';
      d._label = opts.isDefault ? opts.name + ' is the host default' : 'Set ' + opts.name + ' as host default';
      d.setAttribute('aria-label', d._label);
      d.addEventListener('click', function(ev){ ev.stopPropagation(); setDefault(opts.defaultVoice, d); });
      actions.appendChild(d);
    }
    li.appendChild(actions);
    return li;
  }

  function draw(data){
    var list = $('list'); list.textContent = '';
    var voices = data.voices || [];
    var current = data.current || '';
    var def = data['default'] || '';
    $('empty').hidden = voices.length > 0;

    // the host default, which clearing the override falls back to
    list.appendChild(rowFor({
      name: 'Host default',
      sub: def ? pretty(def) : 'the voice engine\\u2019s own default',
      on: !current,
      onPick: function(row){ set('', row); },
      sampleVoice: ''
    }));

    if(current && voices.indexOf(current) < 0){
      list.appendChild(rowFor({
        name: pretty(current),
        sub: current + ' (unavailable on this host)',
        on: true,
        isDefault: def === current
      }));
    }

    voices.forEach(function(v){
      list.appendChild(rowFor({
        name: pretty(v),
        sub: v,
        on: current === v,
        onPick: function(row){ set(v, row); },
        sampleVoice: v,
        defaultVoice: v,
        isDefault: def === v
      }));
    });
  }

  function refresh(token){
    return cyc.call('list', null).then(function(r){
      if(token != null && token !== mutation) return false;
      if(!(r && r.ok && r.result)){
        err((r && r.message) || 'could not load voices');
        return Promise.reject(new Error('list failed'));
      }
      draw(r.result);
      return true;
    }, function(){
      if(token != null && token !== mutation) return false;
      err('could not load voices');
      return Promise.reject(new Error('list failed'));
    });
  }

  refresh().then(function(){}, function(){});
})();
</script>
</body></html>`;
