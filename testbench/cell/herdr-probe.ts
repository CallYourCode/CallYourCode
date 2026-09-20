/* Herdr-in-docker probe (brief: prove or disprove FIRST).
 *
 * Runs INSIDE a base-image container with --network none:
 *   herdr server --session cell   (headless, HOME inside the cell)
 *   workspace create, tab/pane listing, pane send-text + read,
 *   pane process-info, events.subscribe over the NDJSON socket.
 * Writes every step and its raw output to /out/herdr-probe.log and a
 * verdict json to /out/herdr-probe.json. Exit 0 only when every step passed.
 *
 *   bun testbench/run.ts --probe-herdr        (from the host)
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.CELL_OUT ?? "/out";
const HOME = process.env.CELL_HOME ?? "/cell/home";
const WORK = process.env.CELL_WORK ?? "/cell/work";
mkdirSync(OUT, { recursive: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(WORK, { recursive: true });
const LOG = join(OUT, "herdr-probe.log");
writeFileSync(LOG, "");
const log = (s: string) => { appendFileSync(LOG, s + "\n"); console.log(s); };
const steps: { name: string; ok: boolean; detail: string }[] = [];
const step = (name: string, ok: boolean, detail: string) => { steps.push({ name, ok, detail }); log(`[${ok ? "ok" : "FAIL"}] ${name}: ${detail.slice(0, 2000)}`); };

const env = { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config") };
const sock = join(HOME, ".config", "herdr", "sessions", "cell", "herdr.sock");

async function sh(args: string[], ms = 10_000): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), ms);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  log(`$ ${args.join(" ")}\n  exit=${code}\n  out=${out.trim().slice(0, 1500)}\n  err=${err.trim().slice(0, 800)}`);
  return { code, out, err };
}

async function rpc(method: string, params: Record<string, unknown> = {}, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { reject(new Error(`rpc ${method} timeout`)); }, ms);
    Bun.connect({
      unix: sock,
      socket: {
        open(s) { s.write(JSON.stringify({ id: "probe", method, params }) + "\n"); },
        data(_s, d) {
          buf += Buffer.from(d).toString();
          const i = buf.indexOf("\n");
          if (i >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, i))); }
        },
        error(_s, e) { clearTimeout(timer); reject(e); },
        close() { clearTimeout(timer); if (buf.trim()) { try { resolve(JSON.parse(buf.trim().split("\n")[0])); } catch { reject(new Error("bad reply")); } } else reject(new Error("closed")); },
      },
    }).catch(reject);
  });
}

const v = await sh(["herdr", "--version"]);
step("herdr binary runs", v.code === 0, v.out.trim() || v.err.trim());

const server = Bun.spawn(["herdr", "server", "--session", "cell"], { env, stdout: "pipe", stderr: "pipe", cwd: WORK });
const serverOut: string[] = [];
for (const s of [server.stdout, server.stderr]) {
  (async () => { const r = s.getReader(); const dec = new TextDecoder(); for (;;) { const { done, value } = await r.read(); if (done) break; serverOut.push(dec.decode(value)); } })();
}
let up = false;
for (let i = 0; i < 100 && !up; i++) { await Bun.sleep(100); up = existsSync(sock); }
step("server socket appears", up, `${sock} exists=${up} after ${up ? "<10s" : "10s"}; server output: ${serverOut.join("").slice(0, 800)}`);

let paneId = "";
if (up) {
  const st = await sh(["herdr", "--session", "cell", "status"]);
  step("herdr status", st.code === 0, st.out.trim().slice(0, 400));
  const ws = await sh(["herdr", "--session", "cell", "workspace", "create", "--cwd", WORK, "--no-focus", "--label", "probe"]);
  step("workspace create", ws.code === 0, ws.out.trim().slice(0, 400));
  await Bun.sleep(1500);
  /* the CLI prints json by default: {"id":"cli:...","result":{...}} */
  const pl = await sh(["herdr", "--session", "cell", "pane", "list"]);
  let panes: any[] = [];
  try { const j = JSON.parse(pl.out); const r = j.result ?? j; panes = Array.isArray(r) ? r : r.panes ?? r.items ?? []; } catch { /* below */ }
  paneId = panes[0]?.pane_id ?? panes[0]?.id ?? "";
  step("pane list has a pane", !!paneId, `panes=${JSON.stringify(panes).slice(0, 600)}`);
  if (paneId) {
    /* process-info takes --pane; send-text/send-keys/read/close take the id positionally (0.8.2) */
    const pi = await sh(["herdr", "--session", "cell", "pane", "process-info", "--pane", paneId]);
    step("pane process-info", pi.code === 0 && /shell_pid|foreground/.test(pi.out), pi.out.trim().slice(0, 600));
    const st2 = await sh(["herdr", "--session", "cell", "pane", "send-text", paneId, "echo HERDR-PROBE-$((6*7))"]);
    const k = await sh(["herdr", "--session", "cell", "pane", "send-keys", paneId, "enter"]);
    await Bun.sleep(1500);
    const rd = await sh(["herdr", "--session", "cell", "pane", "read", paneId, "--source", "visible", "--format", "text"]);
    step("send-text + Enter + read", st2.code === 0 && k.code === 0 && /HERDR-PROBE-42/.test(rd.out), rd.out.trim().slice(-400));
    try {
      const snap = await rpc("session.snapshot", {});
      step("socket session.snapshot", !!snap && !snap.error, JSON.stringify(snap).slice(0, 400));
    } catch (e) { step("socket session.snapshot", false, String(e)); }
    try {
      /* events.subscribe streams; open it, cause a pane.updated by typing,
       * and see any event line arrive within 5 s */
      const got = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("no event in 6s; buf=" + buf.slice(0, 300))), 6000);
        Bun.connect({ unix: sock, socket: {
          open(s) { s.write(JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions: [{ type: "pane.created" }, { type: "pane.closed" }, { type: "pane.updated" }, { type: "pane.agent_detected" }, { type: "workspace.created" }] } }) + "\n"); },
          data(_s, d) { buf += Buffer.from(d).toString(); if (/"event"/.test(buf) && buf.includes("\n")) { clearTimeout(timer); resolve(buf); } },
          error(_s, e) { clearTimeout(timer); reject(e); },
          close() { clearTimeout(timer); resolve(buf); },
        } }).catch(reject);
        setTimeout(() => sh(["herdr", "--session", "cell", "pane", "send-text", paneId, "x"]), 800);
        setTimeout(() => sh(["herdr", "--session", "cell", "workspace", "create", "--cwd", WORK, "--no-focus"]), 1600);
      });
      step("socket events.subscribe streams", /"event"/.test(got), got.slice(0, 600));
    } catch (e) { step("socket events.subscribe streams", false, String(e)); }
    const cl = await sh(["herdr", "--session", "cell", "pane", "close", paneId]);
    step("pane close", cl.code === 0, cl.out.trim().slice(0, 200) || cl.err.trim().slice(0, 200));
  }
  await sh(["herdr", "--session", "cell", "server", "stop"]).catch(() => {});
}
server.kill();
await Bun.sleep(300);
log(`server output tail: ${serverOut.join("").slice(-1500)}`);
const ok = steps.every((s) => s.ok);
const verdict = { ok, verdict: ok ? "herdr runs in docker" : "herdr-no-docker", steps, ts: new Date().toISOString() };
writeFileSync(join(OUT, "herdr-probe.json"), JSON.stringify(verdict, null, 2));
log(`VERDICT: ${verdict.verdict}`);
process.exit(ok ? 0 : 1);
