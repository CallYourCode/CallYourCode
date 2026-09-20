/* A herdr socket that is not his herdr.
 *
 * The engine's /new-session is one guard and one `tab.create`, and neither can
 * be exercised against the real thing: creating a tab on his machine is exactly
 * what a test must never do. This speaks herdr's line protocol over a unix
 * socket of our choosing (HERDR_SOCKET_PATH), serves one invented workspace
 * with one invented agent pane, and records every request it was sent.
 *
 *   node e2e/fake-herdr.mjs /tmp/fake-herdr.sock /tmp/fake-herdr.jsonl
 *
 * Every request lands in the jsonl file, one object per line, so a run can be
 * read afterwards rather than watched.
 */
import {createServer} from 'node:net';
import {appendFileSync, unlinkSync, writeFileSync} from 'node:fs';

const SOCK = process.argv[2] ?? '/tmp/fake-herdr.sock';
const LOG = process.argv[3] ?? '/tmp/fake-herdr.jsonl';
/* tab.create answers with this; set FAKE_HERDR_FAIL to make it refuse the way
 * an unhappy herdr does. */
const FAIL = process.env.FAKE_HERDR_FAIL ?? '';

const WS = 'ws-fixture-1';
const TAB = 'tab-fixture-1';
const PANE = 'w1:p1';
const CWD = '/tmp/fixture-project';

let made = 0;

const snapshot = () => ({
  snapshot: {
    workspaces: [{workspace_id: WS, number: 1, label: 'fixture', tab_count: 1}],
    tabs: [{tab_id: TAB, workspace_id: WS, number: 1, label: '1'}],
    agents: [{
      pane_id: PANE, workspace_id: WS, tab_id: TAB, agent: 'claude',
      cwd: CWD, agent_status: 'idle', state_change_seq: 1
    }]
  }
});

function handle(msg) {
  appendFileSync(LOG, JSON.stringify(msg) + '\n');
  const {id, method, params} = msg;
  if(method === 'session.snapshot') return {id, result: snapshot()};
  if(method === 'events.subscribe') return {id, result: {ok: true}};
  if(method === 'pane.send_text' || method === 'pane.send_keys') return {id, result: {ok: true}};
  if(method === 'pane.read') return {id, result: {read: {text: '', truncated: false}}};
  if(method === 'tab.create') {
    if(FAIL) return {id, error: {code: -32602, message: FAIL}};
    made++;
    // herdr's own shape (herdr api schema, server 0.7.3): the pane id is
    // NESTED under root_pane, and there is nothing at the top level
    return {id, result: {
      type: 'tab_created',
      tab: {tab_id: `tab-new-${made}`, workspace_id: WS, number: made + 1,
        label: String(made + 1), focused: false, pane_count: 1, agent_status: 'unknown'},
      root_pane: {pane_id: `w9:p${made}`, terminal_id: `t-${made}`, workspace_id: WS,
        tab_id: `tab-new-${made}`, focused: false, agent_status: 'unknown',
        revision: 1, cwd: params?.cwd ?? null}
    }};
  }
  return {id, error: {code: -32601, message: `unknown variant \`${method}\``}};
}

try { unlinkSync(SOCK); } catch {}
writeFileSync(LOG, '');

const server = createServer((conn) => {
  let buf = '';
  conn.on('error', () => {});
  conn.on('data', (chunk) => {
    buf += chunk.toString();
    for(;;) {
      const i = buf.indexOf('\n');
      if(i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if(!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      conn.write(JSON.stringify(handle(msg)) + '\n');
    }
  });
});
server.listen(SOCK, () => process.stdout.write(`fake herdr on ${SOCK}\n`));
process.on('SIGTERM', () => { try { unlinkSync(SOCK); } catch {} process.exit(0); });
