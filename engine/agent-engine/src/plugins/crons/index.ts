/* CRONS AS A FULL PLUGIN (blueprint section 2, the flagship).
 *
 * This plugin OWNS the schedules vertical: the store (schedules.ts beside it),
 * the cron arithmetic, its own clock (the ticker), the firing and its wording,
 * the seeding, and the panel. The engine core keeps ZERO schedule knowledge:
 * everything the plugin needs from the engine arrives through the four host
 * verbs of the typed core contract -- an engine-scoped store (the lock lives
 * there), an agent-scoped store per agent (schedules.json lives there),
 * agentIds() to scan the scopes, and deliver() with the guardCwd identity
 * check. There is no tick hook (the plugin runs its own
 * setInterval), no session-fact seam (records key on the stable agent id the
 * rpc ctx carries), and no isOpen (a closed session's delivery answers
 * retriable:true and the retry ladder absorbs it).
 *
 * WIRE: everything rides the ONE /plugin/crons/rpc/<op> route -- list (which
 * also seeds a first-seen agent), create, update, remove, preview, count (the
 * toolbar badge). The old /session/<id>/schedules routes, the /schedules/*
 * routes and the {t:"schedules"} frame are gone; the panel re-lists.
 *
 *   bun test agent-engine/src/plugins/crons/crons.test.ts
 */

import { join } from "node:path";
import {
  Schedules, hostZone, validZone, parseCron, nextCronAt, wallAt,
  GRACE_MS, type Schedule,
} from "./schedules.ts";
import type { PluginSpec, RpcCtx } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";
import { realClock, type Clock } from "../../runtime/clock.ts";

/* Crons owns a store + a loop; from the engine it needs ONLY the four durable
 * data + delivery verbs, so it takes exactly that slice of the typed core
 * contract (its host verbs) rather than the whole surface or a wider engine
 * handle. Narrowest possible: the plugin cannot even see a read, a command, or
 * the fs verbs it has no business touching. */
type CronsCore = Pick<PluginCore, "store" | "agentStore" | "agentIds" | "deliver">;

/* The engine's old profile-embed sentence, owned here now: the plugin is the
 * one surface that describes its own delivery behaviour. */
const CRONS_INTRO =
  "Messages the engine sends this session on its own. " +
  "If the machine was asleep at that moment, they arrive when it wakes.";

/** A wall clock, in the schedule's own zone, for a line the agent reads. */
export function clockIn(ms: number, tz: string): string {
  const w = wallAt(ms, tz);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p2(w.mo)}-${p2(w.d)} ${p2(w.h)}:${p2(w.mi)} ${tz}`;
}

type Fire = { due: number; at: number; lateMs: number; missed: number; try: number };

/* WHAT THE AGENT IS TOLD BESIDES THE MESSAGE (his ladder, 2026-08-09).
 *
 * The name, always: that is the identifier a job is known by. Then, only when
 * there is something unusual to say: within five minutes a run is simply on
 * time and says nothing extra; later than that it says how late; several
 * missed runs merge into the latest with a count; a retry names its attempt. */
export function noteFor(sc: Schedule, fire: Fire): string {
  const bits = [sc.name];
  const dayStale = fire.lateMs > 24 * 3_600_000;
  if (!dayStale && fire.lateMs > 5 * 60_000) {
    bits.push(`due ${clockIn(fire.due, sc.tz)}, delivered ${Math.round(fire.lateMs / 60_000)} min late`);
  }
  if (fire.missed) {
    bits.push(`${fire.missed} earlier run${fire.missed > 1 ? "s" : ""} were missed and are not being repeated`);
  }
  if (fire.try > 1) bits.push(`attempt ${fire.try}, the session was not reachable earlier`);
  return bits.join("; ");
}

/* Past a DAY the body is not worth acting on any more, so a status line goes
 * out instead -- when it was due and what the schedule is -- and the next run
 * arrives on its own time. */
export function bodyFor(sc: Schedule, fire: Fire): string {
  const dayStale = fire.lateMs > 24 * 3_600_000;
  if (!dayStale) return sc.body;
  return `This run of ${sc.name} was due ${clockIn(fire.due, sc.tz)}, more than a day ago, ` +
    "so its instruction is not being repeated. " +
    (sc.kind === "repeat" && sc.cron
      ? `The schedule repeats (${sc.cron}) and the next run will arrive on time.`
      : "It was a one-off.");
}

/* One schedule, shaped for the page: only the fields it draws, no internals. */
function wireSchedule(sc: Schedule) {
  return {
    id: sc.id, name: sc.name, body: sc.body, kind: sc.kind, tz: sc.tz,
    at: sc.at ?? null, cron: sc.cron ?? null, enabled: sc.enabled,
    nextAt: sc.nextAt, done: !!sc.done, overdueMs: sc.overdueMs ?? null,
  };
}

/* THE FIRST TICK IS LATE ON PURPOSE. Anything due while the engine was down is
 * due the instant it boots, and at that instant the mux has not answered yet,
 * so every session is unknown and every catch-up would record "no such pane".
 * Ten seconds is comfortably past the first snapshot; the retry pass would
 * have rescued it anyway, this just keeps the normal case off the failure
 * path. Env-tunable so a test does not wait ten wall seconds. */
const FIRST_TICK_DELAY_MS = Number(process.env.CYC_CRONS_FIRST_TICK_MS ?? 10_000);

export function cronsPlugin(host: CronsCore, opts?: {
  log?: (event: string, fields: Record<string, unknown>) => void;
  /* THE PLUGIN'S OWN CLOCK, threaded into the store as well as into the boot
   * timer below. Defaults to realClock, so the engine behaves exactly as it
   * did; a test hands it a manual one and the deliberately-late first tick,
   * the fifteen second ticker and every due-ness decision come off the same
   * instrument instead of off ten wall seconds. */
  clock?: Clock;
}): PluginSpec {
  const log = opts?.log ?? ((event, fields) => {
    console.log(`[crons] ${event} ${JSON.stringify(fields)}`);
  });
  const clock = opts?.clock ?? realClock;

  const fileFor = (agent: string) => join(host.agentStore(agent).dir, "schedules.json");

  const store = new Schedules({
    /* Schedules are AGENT-SCOPED plugin data (design two-axis rule): each
     * agent's records live in its own agents/<aid>/plugins/crons/, found at
     * load by scanning the agent scopes, while ONE host-wide lock in the
     * plugin's ENGINE scope keeps the fire-exactly-once rule engine-wide.
     * (The lock used to be state/schedules.lock; under the minimal host a
     * plugin cannot write state/, so it moved here. Same invariant.) */
    files: {
      lockFile: join(host.store().dir, "schedules.lock"),
      fileFor,
      list: async () => {
        const out: { path: string; agent: string }[] = [];
        for (const aid of await host.agentIds()) {
          const p = fileFor(aid);
          if (await Bun.file(p).exists()) out.push({ path: p, agent: aid });
        }
        return out;
      },
    },
    log,
    /* A cron is a message TO the agent, not one FROM him (#515): host.deliver
     * lands it via deliverToAgent semantics, no user chat row, no reply hook.
     * The cwd identity check (a reused pane must never receive another
     * conversation's standup) is the host's guardCwd guarantee. */
    deliver: async (sc, fire) => host.deliver(sc.agent, {
      how: "SCHEDULED",
      note: noteFor(sc, fire),
      text: bodyFor(sc, fire),
      guardCwd: sc.cwd,
      /* The occurrence's stable id, so a retry inside the stranded TTL presses
       * enter only on the body already sitting in the pane rather than typing a
       * second copy of the scheduled message. */
      deliveryId: fire.deliveryId,
    }),
    /* No frame to broadcast: the panel re-lists after every mutation. */
    onChange: () => {},
    clock,
  });

  /* THE PLUGIN'S OWN LOOP: load, then the deliberately-late first tick. */
  let bootTimer: unknown = null;
  const ready: Promise<void> = store.load().then(() => {
    bootTimer = clock.setTimeout(() => {
      bootTimer = null;
      void store.tick();
      store.start();
    }, FIRST_TICK_DELAY_MS);
  });

  const requireAgent = (ctx: RpcCtx): string => {
    if (!ctx.session) throw new Error("this panel needs a session");
    if (!ctx.agent) throw new Error("no such session");
    return ctx.agent;
  };

  /* A page may only touch a schedule of ITS OWN agent. The id carries its
   * agent, but a page could pass any id; membership is checked here so a panel
   * cannot edit or delete another conversation's schedule by guessing one. */
  const ownedId = (agent: string, id: string): string => {
    if (!id) throw new Error("which schedule");
    if (!store.list(agent).some((s) => s.id === id)) throw new Error("no such schedule on this session");
    return id;
  };

  /* DEFAULT CRONS, seeded ON FIRST LIST of an agent with no data and no
   * `seeded` marker (his call, 2026-08-09: disabled examples to see and switch
   * on, not schedules that start driving a session nobody asked to be driven).
   * Seeding on first PANEL OPEN rather than first sight kills both the
   * lifecycle need and the TEST-SINK exemption: a sink never opens the panel.
   * The marker lives in the agent's own crons store (it left meta.json); an
   * agent whose schedules.json already exists is marked without being touched,
   * which also honours a legacy agent that deleted its seeds (the empty file
   * persists). */
  const maybeSeed = async (agent: string): Promise<void> => {
    try {
      const marks = host.agentStore(agent);
      if ((await marks.get("seeded")) === true) return;
      if (store.refuse()) return; // not writable now; retried on the next list
      const touched = await Bun.file(fileFor(agent)).exists();
      if (!touched && store.list(agent).length === 0) {
        await store.create({ agent, name: "nudge",
          body: "continue building items that are left and don't need my input.",
          kind: "repeat", cron: "*/30 * * * *", enabled: false });
        await store.create({ agent, name: "morning-report",
          body: "It is 8am. Morning report: check what got done overnight by " +
            "looking through the session files. What got done over the last " +
            "24 hours and what needs attention.",
          kind: "repeat", cron: "0 8 * * *", enabled: false });
        await store.create({ agent, name: "due-today",
          body: "Read due.md in this project. Each line is a date and a task, " +
            "like 2026-09-01: pay the AI bill. Tell me what is due today and " +
            "what is overdue. If there is no due.md yet, say so and offer to " +
            "start one.",
          kind: "repeat", cron: "0 8 * * *", enabled: false });
        log("schedule.seeded", { agent });
      }
      await marks.put("seeded", true);
    } catch (e) {
      log("schedule.seed-failed", { agent, err: String(e) });
    }
  };

  return {
    id: "crons",
    name: "Schedules",
    version: 2,
    panel: {
      icon: "clock",
      label: "Schedules",
      needsSession: true,
      dock: "side",
      html: async () => CRONS_HTML,
      ops: ["list", "create", "update", "remove", "preview"],
      /* The toolbar chip the native cron-count used to draw off the deleted
       * {t:"schedules"} frame: the app polls this op instead. */
      badge: "count",
    },
    rpc: {
      list: async (ctx) => {
        const agent = requireAgent(ctx);
        await ready;
        await maybeSeed(agent);
        return {
          schedules: store.list(agent).map(wireSchedule),
          tz: hostZone(),
          intro: CRONS_INTRO,
          now: clock.now(),
          graceMs: GRACE_MS,
          readOnly: store.refuse() ?? null,
        };
      },
      create: async (ctx, args) => {
        const agent = requireAgent(ctx);
        await ready;
        const stuck = store.refuse();
        if (stuck) throw new Error(stuck);
        const a = (args ?? {}) as Record<string, unknown>;
        const sc = await store.create({
          agent,
          name: String(a.name ?? ""),
          body: String(a.body ?? ""),
          kind: a.kind === "repeat" ? "repeat" : "once",
          tz: typeof a.tz === "string" ? a.tz : undefined,
          at: Number.isFinite(a.at as number) ? Number(a.at) : undefined,
          cron: typeof a.cron === "string" ? a.cron : undefined,
          enabled: a.enabled !== false,
          /* The wrong-conversation guard: the caller may pin the directory
           * (the update op already accepted cwd repairs on the old wire). A
           * record without one simply has no cwd guard, exactly as before. */
          cwd: typeof a.cwd === "string" && a.cwd ? a.cwd : undefined,
        });
        return { schedule: wireSchedule(sc) };
      },
      update: async (ctx, args) => {
        const agent = requireAgent(ctx);
        await ready;
        const a = (args ?? {}) as Record<string, unknown>;
        const id = ownedId(agent, String(a.id ?? ""));
        const patch: Parameters<Schedules["update"]>[1] = {};
        if (typeof a.name === "string") patch.name = a.name;
        if (typeof a.body === "string") patch.body = a.body;
        if (typeof a.tz === "string") patch.tz = a.tz;
        if (Number.isFinite(a.at as number)) patch.at = Number(a.at);
        if (typeof a.cron === "string") patch.cron = a.cron;
        if (typeof a.enabled === "boolean") patch.enabled = a.enabled;
        if (typeof a.cwd === "string") patch.cwd = a.cwd;
        if (a.kind === "once" || a.kind === "repeat") patch.kind = a.kind;
        const sc = await store.update(id, patch);
        return { schedule: wireSchedule(sc) };
      },
      remove: async (ctx, args) => {
        const agent = requireAgent(ctx);
        await ready;
        const a = (args ?? {}) as Record<string, unknown>;
        const id = ownedId(agent, String(a.id ?? ""));
        return { ok: await store.remove(id) };
      },
      /* When would this fire? Answered by the same code that will fire it, so
       * no client ever owns a second opinion about what a cron means. The old
       * GET /schedules/preview, as an op. */
      preview: async (_ctx, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const cron = typeof a.cron === "string" ? a.cron : "";
        const tz = (typeof a.tz === "string" && a.tz) ? a.tz : hostZone();
        if (!validZone(tz)) throw Object.assign(new Error("no such timezone"), { status: 400 });
        if (!parseCron(cron)) throw Object.assign(new Error("that is not a cron expression"), { status: 400 });
        const next: number[] = [];
        let cursor = clock.now();
        for (let i = 0; i < 5; i++) {
          const n = nextCronAt(cron, cursor, tz);
          if (n === null) break;
          next.push(n);
          cursor = n;
        }
        return { next, tz };
      },
      /* The toolbar badge: how many schedules this conversation has enabled. */
      count: async (ctx) => {
        if (!ctx.agent) return { count: 0 };
        await ready;
        return { count: store.list(ctx.agent).filter((s) => s.enabled).length };
      },
    },
    dispose: () => {
      if (bootTimer) { clock.clearTimeout(bootTimer); bootTimer = null; }
      store.stop();
    },
  };
}

/* THE PANEL PAGE. Self-contained HTML+CSS+JS, run in the show sandbox (no
 * network of its own; every read and write is a cyc.call the app performs
 * against this engine). Plain ES so it runs anywhere the sandbox does. It uses
 * the app's --cyc-* theme vars (frameDocument injects them). The layout is the
 * native schedulesPage: list + add, then an editor with the preset picker, a
 * next-fire preview, and a primary Save. */
const CRONS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Schedules</title>
<style>
  body{margin:0;padding:16px;font-size:14px}
  .intro{color:var(--cyc-muted);font-size:12px;line-height:1.4;margin:0 0 4px}
  .zone{color:var(--cyc-muted);font-size:11px;line-height:1.3;margin:0 0 14px;opacity:.85}
  .ro{color:#e06c62;font-size:12px;margin:0 0 8px}
  #list{list-style:none;margin:0;padding:0}
  #list li{display:flex;gap:12px;align-items:center;padding:12px 8px}
  #list li + li{border-top:1px solid var(--cyc-border)}
  #list li.off{opacity:.55}
  #list li .meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  #list li .name{font-weight:500;font-size:15px}
  #list li .sub,#list li .body,#list li .late{color:var(--cyc-muted);font-size:13px}
  #list li .body{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  #list li .side{display:flex;flex-direction:row;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
  .tog{position:relative;display:inline-flex;align-items:center;cursor:pointer;flex:0 0 auto;width:31px;height:20px}
  .tog input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1}
  .tog-track{width:31px;height:14px;background:var(--cyc-muted);border-radius:24px;position:relative;display:block;pointer-events:none}
  .tog-knob{width:20px;height:20px;border:2px solid var(--cyc-muted);background:var(--cyc-surface);border-radius:50%;position:absolute;top:50%;left:0;transform:translate(-3px,-50%);box-sizing:border-box;pointer-events:none}
  .tog input:checked + .tog-track{background:var(--cyc-accent)}
  .tog input:checked + .tog-track .tog-knob{border-color:var(--cyc-accent);transform:translate(14px,-50%)}
  .tog input:disabled + .tog-track{opacity:.6}
  .bin{flex:0 0 auto;background:none;border:0;padding:4px;cursor:pointer;color:var(--cyc-muted);line-height:0;border-radius:8px}
  .bin:hover{color:#e06c62}
  .bin:disabled{opacity:.6;cursor:default}
  .empty{color:var(--cyc-muted);font-size:13px;padding:4px 0 8px}
  #add{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;
    color:var(--cyc-accent);font:inherit;font-size:14px;padding:10px 8px;border-radius:8px;cursor:pointer}
  #add:disabled{color:var(--cyc-muted);cursor:default}
  #editor{display:flex;flex-direction:column;gap:10px}
  .field{display:flex;flex-direction:column;gap:4px}
  .field span{font-size:12px;color:var(--cyc-muted)}
  input,textarea,select{font:inherit;font-size:14px;color:var(--cyc-text);
    background:color-mix(in srgb, var(--cyc-muted) 12%, var(--cyc-surface));
    border:1px solid transparent;border-radius:8px;padding:8px 10px;width:100%}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--cyc-accent)}
  textarea{min-height:5rem;resize:vertical}
  #preview{font-size:12px;color:var(--cyc-muted)}
  #preview-head{color:var(--cyc-muted)}
  #preview-times{list-style:none;margin:4px 0 0;padding:0}
  #preview-times li{color:var(--cyc-text);padding:1px 0;font-variant-numeric:tabular-nums}
  .err{color:#e06c62;font-size:13px;min-height:16px}
  .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
  .btn{font:inherit;font-size:14px;padding:8px 14px;border-radius:8px;
    border:1px solid var(--cyc-border);background:none;color:var(--cyc-text);cursor:pointer}
  .btn.primary{background:var(--cyc-fill, var(--cyc-accent));border-color:transparent;color:#fff;font-weight:600;
    box-shadow:0 1px 2px rgba(0,0,0,.16)}
  .btn:disabled{opacity:.6;cursor:default;box-shadow:none}
  button.ghost{font:inherit;cursor:pointer;border:0;background:transparent;color:var(--cyc-muted);padding:4px 6px}
  button.ghost:hover{color:#e06c62}
  [hidden]{display:none !important}
</style></head>
<body>
  <p class="intro" id="intro"></p>
  <p class="ro" id="ro" hidden></p>
  <p class="zone" id="zone">Asking the engine which clock it keeps...</p>
  <div id="list-view">
    <ul id="list"></ul>
    <p class="empty" id="empty" hidden>Nothing is scheduled on this chat.</p>
    <div class="err" id="list-err"></div>
    <button type="button" id="add" disabled>Schedule a message</button>
  </div>
  <div id="editor" hidden>
    <label class="field"><span>Name</span><input id="f-name" maxlength="60" placeholder="morning-plan"></label>
    <label class="field"><span>Message</span><textarea id="f-body" placeholder="What the session should be asked to do."></textarea></label>
    <label class="field"><span>Schedule</span>
      <select id="f-mode">
        <option value="once">Once</option>
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
        <option value="hourly">Every hour</option>
        <option value="custom">Custom cron</option>
      </select>
    </label>
    <label class="field" id="wrap-at"><span id="at-label">Date and time</span><input type="datetime-local" id="f-at"></label>
    <label class="field" id="wrap-time" hidden><span id="time-label">Time</span><input type="time" id="f-time" value="09:00"></label>
    <label class="field" id="wrap-dow" hidden><span>Day</span>
      <select id="f-dow">
        <option value="0">Sunday</option>
        <option value="1" selected>Monday</option>
        <option value="2">Tuesday</option>
        <option value="3">Wednesday</option>
        <option value="4">Thursday</option>
        <option value="5">Friday</option>
        <option value="6">Saturday</option>
      </select>
    </label>
    <label class="field" id="wrap-cron" hidden><span>Cron (minute hour day month weekday)</span>
      <input id="f-cron" placeholder="0 7 * * 1-5"></label>
    <div id="preview"></div>
    <div class="err" id="form-err"></div>
    <div class="actions">
      <button type="button" class="btn" id="f-cancel">Cancel</button>
      <button type="button" class="btn primary" id="f-submit">Schedule it</button>
    </div>
  </div>
<script>
(function(){
  var cyc = window.cyc;
  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var data = {schedules:[], tz:'', intro:'', readOnly:null, now:Date.now()};
  var editing = null;
  var saving = false;
  function $(id){ return document.getElementById(id); }
  function err(m){ $('form-err').textContent = m || ''; }
  function listErr(m){ $('list-err').textContent = m || ''; }
  function setSaving(on){
    saving = on;
    $('f-submit').disabled = on || !data.tz || !!data.readOnly;
    $('f-submit').textContent = on ? 'Saving...' : editing ? 'Save' : 'Schedule it';
  }
  function pad(n){ return String(n).padStart(2,'0'); }
  function zoneLabel(tz){ var p = String(tz||'').split('/'); return (p.pop() || tz).replace(/_/g,' '); }
  function deviceZone(){
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch(e){ return 'UTC'; }
  }
  function partsIn(ms, tz){
    var p = {};
    var list = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date(ms));
    for(var i=0;i<list.length;i++) p[list[i].type] = list[i].value;
    return {y:+p.year, mo:+p.month, d:+p.day, h:+p.hour, mi:+p.minute};
  }
  function instantFrom(w, tz){
    var naive = Date.UTC(w.y, w.mo-1, w.d, w.h, w.mi);
    function offsetAt(ms){
      var p = partsIn(ms, tz);
      return Date.UTC(p.y, p.mo-1, p.d, p.h, p.mi) - Math.floor(ms/60000)*60000;
    }
    var ms = naive - offsetAt(naive);
    return naive - offsetAt(ms);
  }
  function localInputValue(ms, tz){
    var p = partsIn(ms, tz);
    return p.y+'-'+pad(p.mo)+'-'+pad(p.d)+'T'+pad(p.h)+':'+pad(p.mi);
  }
  function whenIn(ms, tz){
    var now = partsIn(Date.now(), tz);
    var t = partsIn(ms, tz);
    var time = pad(t.h)+':'+pad(t.mi);
    if(t.y===now.y && t.mo===now.mo && t.d===now.d) return 'today '+time;
    return new Intl.DateTimeFormat('en-GB', {timeZone:tz, weekday:'short', day:'numeric', month:'short'})
      .format(new Date(ms))+' '+time;
  }
  function alsoHere(ms, tz){
    var here = deviceZone();
    if(here===tz) return '';
    var a = partsIn(ms, tz), b = partsIn(ms, here);
    if(a.h===b.h && a.mi===b.mi) return '';
    return ' ('+pad(b.h)+':'+pad(b.mi)+' here)';
  }
  function describeCron(cron){
    var f = String(cron||'').trim().split(/\\s+/);
    if(f.length!==5) return cron;
    var mi=f[0], hr=f[1], dom=f[2], mo=f[3], dow=f[4];
    function num(s){ return /^\\d+$/.test(s) ? Number(s) : null; }
    var m = num(mi), hh = num(hr);
    if(hr==='*' && dom==='*' && mo==='*' && dow==='*' && m!==null){
      return m===0 ? 'Every hour' : 'Every hour at :'+pad(m);
    }
    if(m===null || hh===null || mo!=='*') return cron;
    var at = pad(hh)+':'+pad(m);
    if(dom==='*' && dow==='*') return 'Every day at '+at;
    if(dom==='*' && dow==='1-5') return 'Weekdays at '+at;
    if(dom==='*' && dow==='0,6') return 'Weekends at '+at;
    var d = num(dow);
    if(dom==='*' && d!==null) return 'Every '+DAYS[d%7]+' at '+at;
    var day = num(dom);
    if(dow==='*' && day!==null) return 'Monthly on the '+day+' at '+at;
    return cron;
  }
  function modeOf(sc){
    if(!sc || sc.kind!=='repeat' || !sc.cron) return 'once';
    var f = String(sc.cron).split(/\\s+/);
    if(f.length===5 && f[0]==='0' && f[1]==='*' && f[2]==='*' && f[3]==='*' && f[4]==='*') return 'hourly';
    if(f.length===5 && /^\\d+$/.test(f[0]) && /^\\d+$/.test(f[1]) && f[2]==='*' && f[3]==='*'){
      if(f[4]==='*') return 'daily';
      if(/^\\d$/.test(f[4])) return 'weekly';
    }
    return 'custom';
  }
  function cronOf(){
    var mode = $('f-mode').value;
    if(mode==='custom') return $('f-cron').value.trim();
    if(mode==='hourly') return '0 * * * *';
    var parts = ($('f-time').value || '09:00').split(':');
    var hh = String(Number(parts[0])||0), mm = String(Number(parts[1])||0);
    if(mode==='daily') return mm+' '+hh+' * * *';
    return mm+' '+hh+' * * '+($('f-dow').value||'1');
  }
  function parseWhen(){
    if(!data.tz) return null;
    var v = $('f-at').value;
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(v);
    if(!m) return null;
    return instantFrom({y:+m[1], mo:+m[2], d:+m[3], h:+m[4], mi:+m[5]}, data.tz);
  }
  function syncMode(){
    var mode = $('f-mode').value;
    $('wrap-at').hidden = mode!=='once';
    $('wrap-time').hidden = !(mode==='daily' || mode==='weekly');
    $('wrap-dow').hidden = mode!=='weekly';
    $('wrap-cron').hidden = mode!=='custom';
    var z = zoneLabel(data.tz || 'UTC');
    $('at-label').textContent = 'Date and time ('+z+')';
    $('time-label').textContent = 'Time ('+z+')';
    refreshPreview();
  }
  /* The next-fire times come from the ENGINE's preview op -- the same
   * nextCronAt that will fire the schedule -- so this page holds no second
   * opinion about what a cron means. previewSeq keeps a slow answer from
   * landing over a newer keystroke's. */
  var previewSeq = 0;
  function refreshPreview(){
    var box = $('preview');
    var mode = $('f-mode').value;
    var tz = data.tz || 'UTC';
    var seq = ++previewSeq;
    if(mode==='once'){
      var ms = parseWhen();
      box.textContent = ms===null ? 'Pick a date and time.'
        : ms<=Date.now() ? 'That time has already passed.'
        : 'Fires '+whenIn(ms, tz)+' '+zoneLabel(tz)+alsoHere(ms, tz);
      return;
    }
    cyc.call('preview', {cron: cronOf(), tz: tz}).then(function(r){
      if(seq!==previewSeq) return;
      if(!r || !r.ok || !r.result){ box.textContent = 'That is not a cron expression yet.'; return; }
      var next = r.result.next || [];
      if(!next.length){ box.textContent = 'That never comes round.'; return; }
      box.textContent = '';
      var head = document.createElement('div'); head.id='preview-head';
      head.textContent = 'Next: '+zoneLabel(tz);
      var ul = document.createElement('ul'); ul.id='preview-times';
      for(var i=0;i<next.length;i++){
        var li = document.createElement('li');
        li.textContent = whenIn(next[i], tz)+alsoHere(next[i], tz);
        ul.appendChild(li);
      }
      box.appendChild(head); box.appendChild(ul);
    }, function(){
      if(seq===previewSeq) box.textContent = 'That is not a cron expression yet.';
    });
  }
  function whenLine(sc){
    var what = sc.kind==='repeat' && sc.cron ? describeCron(sc.cron) : 'Once';
    if(!sc.enabled) return what+' \\u00b7 paused';
    if(sc.nextAt==null){
      return sc.kind==='once' && sc.done ? what+' \\u00b7 already fired' : what+' \\u00b7 nothing more will fire';
    }
    var tz = sc.tz || data.tz || 'UTC';
    return what+' \\u00b7 next '+whenIn(sc.nextAt, tz)+' '+zoneLabel(tz)+alsoHere(sc.nextAt, tz);
  }
  function overdueLine(ms){
    if(!ms || ms<=0) return '';
    if(ms<60000) return 'late by '+Math.round(ms/1000)+'s';
    return 'late by '+Math.round(ms/60000)+'m';
  }
  function showList(){
    editing = null;
    saving = false;
    $('editor').hidden = true;
    $('list-view').hidden = false;
    $('f-submit').textContent = 'Schedule it';
  }
  function showEditor(sc){
    if(!data.tz || data.readOnly) return;
    editing = sc || null;
    $('list-view').hidden = true;
    $('editor').hidden = false;
    err('');
    $('f-name').value = sc ? sc.name : '';
    $('f-body').value = sc ? sc.body : '';
    var mode = modeOf(sc);
    $('f-mode').value = mode;
    var tz = data.tz || 'UTC';
    if(sc && sc.kind==='once' && sc.at) $('f-at').value = localInputValue(sc.at, tz);
    else $('f-at').value = localInputValue(Date.now()+3600000, tz);
    if(sc && sc.cron){
      var f = String(sc.cron).split(/\\s+/);
      if(f.length===5 && /^\\d+$/.test(f[0]) && /^\\d+$/.test(f[1])){
        $('f-time').value = pad(Number(f[1]))+':'+pad(Number(f[0]));
        if(/^\\d$/.test(f[4])) $('f-dow').value = f[4];
      }
      $('f-cron').value = sc.cron;
    } else {
      $('f-time').value = '09:00';
      $('f-dow').value = '1';
      $('f-cron').value = '0 9 * * *';
    }
    $('f-submit').textContent = sc ? 'Save' : 'Schedule it';
    $('f-submit').disabled = saving || !data.tz || !!data.readOnly;
    syncMode();
  }
  function draw(){
    $('intro').textContent = data.intro || '';
    var ro = data.readOnly;
    $('ro').hidden = !ro; $('ro').textContent = ro || '';
    $('zone').textContent = data.tz
      ? "Times are on the engine's clock: "+zoneLabel(data.tz)
      : "Asking the engine which clock it keeps...";
    $('add').disabled = !data.tz || !!ro;
    var list = $('list'); list.textContent = '';
    var items = data.schedules || [];
    $('empty').hidden = items.length>0;
    items.forEach(function(sc){
      var li = document.createElement('li');
      if(!sc.enabled) li.className = 'off';
      var meta = document.createElement('div'); meta.className = 'meta';
      var name = document.createElement('div'); name.className = 'name'; name.textContent = sc.name;
      var sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = whenLine(sc);
      meta.appendChild(name); meta.appendChild(sub);
      var late = overdueLine(sc.overdueMs);
      if(late){
        var l = document.createElement('div'); l.className = 'late'; l.textContent = late;
        meta.appendChild(l);
      }
      if(sc.body){
        var body = document.createElement('div'); body.className = 'body'; body.textContent = sc.body;
        meta.appendChild(body);
      }
      var side = document.createElement('div'); side.className = 'side';
      var toggle = document.createElement('label'); toggle.className = 'tog';
      var togIn = document.createElement('input');
      togIn.type = 'checkbox';
      togIn.checked = !!sc.enabled;
      togIn.disabled = !!ro;
      togIn.setAttribute('role', 'switch');
      togIn.setAttribute('aria-checked', sc.enabled ? 'true' : 'false');
      togIn.setAttribute('aria-label', (sc.enabled?'Pause ':'Resume ')+sc.name);
      var track = document.createElement('span'); track.className = 'tog-track';
      var knob = document.createElement('span'); knob.className = 'tog-knob';
      track.appendChild(knob);
      toggle.appendChild(togIn); toggle.appendChild(track);
      toggle.addEventListener('click', function(e){ e.stopPropagation(); });
      togIn.addEventListener('change', function(){
        call('update', {id: sc.id, enabled: !!togIn.checked}, true);
      });
      var del = document.createElement('button'); del.className = 'bin';
      del.disabled = !!ro;
      del.setAttribute('aria-label', 'Delete '+sc.name);
      del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>';
      del.addEventListener('click', function(e){
        e.stopPropagation();
        del.hidden = true;
        toggle.hidden = true;
        var confirm = document.createElement('button'); confirm.className = 'btn';
        confirm.textContent = 'Confirm delete';
        var cancelDelete = document.createElement('button'); cancelDelete.className = 'ghost';
        cancelDelete.textContent = 'Cancel';
        confirm.addEventListener('click', function(ev){
          ev.stopPropagation();
          confirm.disabled = true; cancelDelete.disabled = true;
          call('remove', {id: sc.id}, true).then(function(ok){
            if(!ok){ confirm.disabled = false; cancelDelete.disabled = false; }
          });
        });
        cancelDelete.addEventListener('click', function(ev){
          ev.stopPropagation();
          confirm.remove(); cancelDelete.remove(); del.hidden = false; toggle.hidden = false;
        });
        side.appendChild(confirm); side.appendChild(cancelDelete);
      });
      side.appendChild(toggle); side.appendChild(del);
      li.appendChild(meta); li.appendChild(side);
      li.addEventListener('click', function(){ showEditor(sc); });
      list.appendChild(li);
    });
  }
  function refresh(){
    return cyc.call('list', null).then(function(r){
      if(r && r.ok && r.result){
        data = r.result;
        listErr('');
        draw();
        if(!editing) showList();
        return true;
      }
      listErr((r && r.message) || 'could not load schedules');
      return false;
    }, function(){
      listErr('could not load schedules');
      return false;
    });
  }
  function call(op, args, onList){
    err(''); listErr('');
    return cyc.call(op, args).then(function(r){
      if(r && r.ok) return refresh();
      (onList ? listErr : err)((r && r.message) || (op+' failed'));
      return false;
    }, function(){
      (onList ? listErr : err)(op+' failed');
      return false;
    });
  }
  $('f-mode').addEventListener('change', syncMode);
  $('f-at').addEventListener('input', refreshPreview);
  $('f-time').addEventListener('input', refreshPreview);
  $('f-dow').addEventListener('change', refreshPreview);
  $('f-cron').addEventListener('input', refreshPreview);
  $('add').addEventListener('click', function(){ showEditor(null); });
  $('f-cancel').addEventListener('click', function(){ err(''); showList(); });
  $('f-submit').addEventListener('click', function(){
    if(saving || !data.tz) return;
    var mode = $('f-mode').value;
    var args = {name: $('f-name').value, body: $('f-body').value,
      kind: mode==='once' ? 'once' : 'repeat', tz: data.tz};
    if(mode==='once'){
      var at = parseWhen();
      if(at===null){ err('Pick a date and time.'); return; }
      args.at = at;
    } else {
      args.cron = cronOf();
    }
    var op = editing ? 'update' : 'create';
    if(editing) args.id = editing.id;
    setSaving(true);
    call(op, args, false).then(function(ok){
      setSaving(false);
      if(ok) showList();
    });
  });
  refresh();
})();
</script>
</body></html>`;
