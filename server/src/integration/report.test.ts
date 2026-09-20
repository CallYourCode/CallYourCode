/* THE RECEIVING END of a bug report filed from the app (#12).
 *
 * A real server process on its own port, writing into its own REPORTS_DIR,
 * because everything worth asserting here is about a FILE existing afterwards:
 * that the anchors survived the trip, that the caps bit, that a refusal is a
 * refusal, and that the directory cannot grow without bound under a thumb.
 *
 * REPORTS_DIR is a temp directory in every test. Nothing here can reach
 * .run/reports, which is where his real reports live.
 *
 *   bun test app-server/report.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Server = { url: string; dir: string; reports: string; stop: () => Promise<void> };
let servers: Server[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

async function startServer(): Promise<Server> {
  const dir = await mkdtemp(join(tmpdir(), "cyc-reports-"));
  dirs.push(dir);
  const reports = join(dir, "reports");
  const port = 8700 + Math.floor(Math.random() * 300);
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      REPORTS_DIR: reports,
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      CYC_LOG_DIR: join(dir, "logs"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${url}/settings`).then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(100);
    if (i === 79) throw new Error("app server did not start");
  }
  const s = { url, dir, reports, stop: async () => { proc.kill(); await proc.exited; } };
  servers.push(s);
  return s;
}

const file = (s: Server, name: string) => Bun.file(join(s.reports, name)).json() as Promise<any>;
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** One report shaped the way lib/report.ts sends them. */
const sample = (over: Record<string, unknown> = {}) => ({
  ref: "r-local-abcde",
  at: "2026-08-06T09:15:00.000Z",
  text: "the voice note showed a tick and never arrived",
  device: "kx91a",
  page: "p7f2q",
  build: "2026-08-06T08.00.00Z-9fe12ab",
  ua: "Mozilla/5.0 (iPhone)",
  screen: "390x844@3",
  session: { id: "example:w9:p4", title: "Relay Server" },
  engine: { state: "disconnected", key: "example" },
  ship: { queued: 41, dropped: 0, failures: 5 },
  cids: ["c-msgg5mok-5ulxu"],
  lines: [
    "2026-08-06T09:14:58.100Z app upload.start dev=kx91a pg=p7f2q cid=c-msgg5mok-5ulxu",
    "2026-08-06T09:14:59.900Z app upload.failed dev=kx91a pg=p7f2q cid=c-msgg5mok-5ulxu",
  ],
  ...over,
});

test("a report lands as one file, with every anchor on it", async () => {
  const s = await startServer();

  const res = await post(`${s.url}/report`, sample());
  expect(res.status).toBe(200);
  const j = await res.json() as any;

  /* THE ID IS THE CONTRACT. The page treats a 200 without one as a refusal, so
   * a server that stored the file and forgot to say so would leave the report
   * in the device's outbox for ever. */
  expect(j.ok).toBe(true);
  expect(typeof j.id).toBe("string");
  expect(j.id).toMatch(/^r-[a-z0-9]+-[a-z0-9]+$/);

  expect(await readdir(s.reports)).toEqual([`${j.id}.json`]);
  expect(statSync(s.reports).mode & 0o777).toBe(0o700);
  expect(statSync(join(s.reports, `${j.id}.json`)).mode & 0o777).toBe(0o600);
  const stored = await file(s, `${j.id}.json`);

  // his words, verbatim
  expect(stored.text).toBe("the voice note showed a tick and never arrived");

  /* THE ANCHORS. Each of these is a thing that cannot be reconstructed from a
   * voice note the next morning, which is the whole reason the button exists. */
  expect(stored.at).toBe("2026-08-06T09:15:00.000Z");   // when HE pressed it
  expect(stored.device).toBe("kx91a");
  expect(stored.page).toBe("p7f2q");
  expect(stored.build).toBe("2026-08-06T08.00.00Z-9fe12ab");
  expect(stored.session).toEqual({ id: "example:w9:p4", title: "Relay Server" });
  expect(stored.engine).toEqual({ state: "disconnected", key: "example" });
  expect(stored.cids).toEqual(["c-msgg5mok-5ulxu"]);
  expect(stored.lines).toHaveLength(2);
  expect(stored.lines[0]).toContain("cid=c-msgg5mok-5ulxu");

  /* AND WHEN IT ARRIVED, separately. The gap between `at` and `received` is how
   * long the app server was unreachable, which is itself the answer to some of
   * these reports. */
  expect(Date.parse(stored.received)).toBeGreaterThan(Date.parse(stored.at));

  /* THE SHIP STATE: five consecutive failures means lib/log.ts had GIVEN UP,
   * so those lines exist nowhere else. A report that dropped this field would
   * make an incomplete log look like a quiet minute. */
  expect(stored.ship).toEqual({ queued: 41, dropped: 0, failures: 5 });

  // nothing was cut, so it does not claim anything was
  expect(stored.truncated).toBeNull();
});

test("a report with no words is refused, and nothing is written", async () => {
  const s = await startServer();

  for (const text of ["", "   ", undefined]) {
    const res = await post(`${s.url}/report`, sample({ text }));
    expect(res.status).toBe(400);
  }
  /* A log dump with no question in it is not a lead. Storing one would put a
   * file in the triage directory that can only ever be deleted. */
  expect(await readdir(s.reports).catch(() => [])).toEqual([]);
});

test("an oversized report is cut down and SAYS it was cut down", async () => {
  const s = await startServer();

  const lines = Array.from({ length: 900 }, (_, i) =>
    `2026-08-06T09:00:00.000Z app line.${i} dev=kx91a pg=p7f2q`);
  const res = await post(`${s.url}/report`, sample({
    lines,
    text: "x".repeat(5000),
  }));
  const { id } = await res.json() as any;
  const stored = await file(s, `${id}.json`);

  // 500 lines is the cap, and they are the LAST 500: the tail is where the
  // moment is, and the head of a nine-hundred-line ring is old news
  expect(stored.lines).toHaveLength(500);
  expect(stored.lines[499]).toContain("line.899");
  expect(stored.lines[0]).toContain("line.400");

  expect(stored.text).toHaveLength(2000);

  /* SAID, NOT IMPLIED. Without this the absence of the line somebody was
   * looking for reads as the event not having happened. */
  expect(stored.truncated).toEqual({ sentLines: 900, keptLines: 500 });
});

test("the directory cannot grow without bound, and the list is newest first", async () => {
  const s = await startServer();

  /* 205 reports against a cap of 200. This is a button on a phone: an
   * unbounded writer under a thumb is how .run/uploads reached 215 files. */
  const ids: string[] = [];
  for (let i = 0; i < 205; i++) {
    const res = await post(`${s.url}/report`, sample({ text: `report number ${i}` }));
    ids.push((await res.json() as any).id);
  }
  const left = await readdir(s.reports);
  expect(left).toHaveLength(200);

  // and it is the OLDEST five that went
  for (const gone of ids.slice(0, 5)) expect(left).not.toContain(`${gone}.json`);
  expect(left).toContain(`${ids[204]}.json`);

  /* THE LIST CARRIES NO LOG LINES, only how many there are: a hundred reports
   * each with four hundred lines is not something anybody wants in one
   * response. The count is still there, because "this one has no log" is worth
   * seeing without opening it. */
  const list = await (await fetch(`${s.url}/reports`)).json() as any;
  expect(list.total).toBe(200);
  expect(list.reports[0].text).toBe("report number 204");   // newest first
  expect(list.reports[0].lines).toBe(2);

  // ...and the whole thing is one GET away
  const one = await (await fetch(`${s.url}/reports/${ids[204]}`)).json() as any;
  expect(one.text).toBe("report number 204");
  expect(one.lines).toHaveLength(2);
  expect(one.lines[0]).toContain("cid=c-msgg5mok-5ulxu");
});

test("an id that is not one of ours never reaches the filesystem", async () => {
  const s = await startServer();
  await post(`${s.url}/report`, sample());

  /* PERCENT-ENCODED, because a plain `../` is rewritten by whoever is calling
   * before the server ever sees it -- so a test that sent one would be testing
   * fetch's URL parser and passing for the wrong reason. These arrive at the
   * route intact, which is the only version of this that proves anything. */
  for (const bad of ["..%2F..%2Fapp-settings", "..%2Freports", "nonsense",
    "r-x", "r-abc-def-ghi", "r-abc-%2E%2E"]) {
    const res = await fetch(`${s.url}/reports/${bad}`);
    expect(res.status, `GET /reports/${bad} was not refused`).toBe(400);
    expect((await res.json() as any).error).toBe("bad id");
  }

  // ...and an id that IS one of ours but names nothing is a plain 404
  const res = await fetch(`${s.url}/reports/r-000000000-zzzzz`);
  expect(res.status).toBe(404);
  expect((await res.json() as any).error).toBe("not found");
});
