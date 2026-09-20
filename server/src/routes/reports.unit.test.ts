/* routes/reports.ts as a unit: the owner gate, the minted-id contract (a 200
 * without an id is a refusal, so the id IS the receipt), the no-words wall,
 * the truncation note, and the pull side. Deep cap/reap behaviour is
 * report.test.ts's live-process job; this proves the route seams. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReportRoutes } from "./reports";
import { REPORT_MAX_LINES } from "../platform/caps";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
const silent = () => {};

async function rig(authorized = true) {
  const d = await mkdtemp(join(tmpdir(), "cyc-reproutes-unit-"));
  dirs.push(d);
  const store = { reportsDir: join(d, "reports") };
  const routes = makeReportRoutes({
    deviceOwner: async () => (authorized ? store : null), log: silent });
  return { store, routes };
}

const post = (body: unknown) => new Request("http://x/report",
  { method: "POST", body: JSON.stringify(body) });

test("without an owner every report surface is a 401", async () => {
  const { routes } = await rig(false);
  expect((await routes(post({ text: "hi" }), "/report"))!.status).toBe(401);
  expect((await routes(new Request("http://x/reports"), "/reports"))!.status).toBe(401);
  expect((await routes(new Request("http://x/reports/r-a-b"), "/reports/r-a-b"))!.status).toBe(401);
});

test("no words, no report: a log dump alone is refused", async () => {
  const { routes } = await rig();
  expect((await routes(post({ text: "   ", lines: ["l1"] }), "/report"))!.status).toBe(400);
});

test("a filed report answers its id and round-trips through the pull side", async () => {
  const { routes } = await rig();
  const filed = await (await routes(post({ text: "the send button sticks",
    device: "d-1", lines: ["a", "b"], cids: ["s-abc"] }), "/report"))!.json();
  expect(filed.ok).toBe(true);
  expect(filed.id).toMatch(/^r-[a-z0-9]{9}-[a-z0-9]{5}$/);

  const list = await (await routes(new Request("http://x/reports"), "/reports"))!.json();
  expect(list.total).toBe(1);
  expect(list.reports[0].id).toBe(filed.id);
  expect(list.reports[0].lines).toBe(2);            // a COUNT in the list, not the lines

  const whole = await (await routes(new Request(`http://x/reports/${filed.id}`),
    `/reports/${filed.id}`))!.json();
  expect(whole.text).toBe("the send button sticks");
  expect(whole.lines).toEqual(["a", "b"]);          // the whole file has them
  expect(whole.truncated).toBeNull();
});

test("oversize lines are cut to the newest and the file SAYS so", async () => {
  const { routes } = await rig();
  const lines = Array.from({ length: REPORT_MAX_LINES + 20 }, (_, i) => `line ${i}`);
  const filed = await (await routes(post({ text: "flooded", lines }), "/report"))!.json();
  const whole = await (await routes(new Request(`http://x/reports/${filed.id}`),
    `/reports/${filed.id}`))!.json();
  expect(whole.lines.length).toBe(REPORT_MAX_LINES);
  expect(whole.lines[0]).toBe("line 20");           // the newest survive
  expect(whole.truncated).toEqual({ sentLines: REPORT_MAX_LINES + 20,
    keptLines: REPORT_MAX_LINES });
});

test("the pull side refuses ids that are not ours", async () => {
  const { routes } = await rig();
  const r = (await routes(new Request("http://x/reports/../../etc"), "/reports/../../etc"))!;
  expect(r.status).toBe(400);
  const missing = (await routes(new Request("http://x/reports/r-zzzzzzzzz-zzzzz"),
    "/reports/r-zzzzzzzzz-zzzzz"))!;
  expect(missing.status).toBe(404);
});

test("other paths fall through as null", async () => {
  const { routes } = await rig();
  expect(await routes(new Request("http://x/settings"), "/settings")).toBeNull();
});
