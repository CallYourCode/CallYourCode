/* reports.ts as a unit: the id discipline (fixed-width, strictly increasing),
 * the one place a wire string reaches the filesystem, and the reap. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportId, reportPath, reportText, reportFiles, reapReports } from "./reports";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
const scratch = async () => {
  const d = await mkdtemp(join(tmpdir(), "cyc-reports-unit-"));
  dirs.push(d);
  return d;
};

test("reportId: nine base36 digits, strictly increasing within the process", () => {
  const ids = Array.from({ length: 50 }, () => reportId());
  for (const id of ids) expect(id).toMatch(/^r-[a-z0-9]{9}-[a-z0-9]{5}$/);
  // a burst in one millisecond still sorts in filing order (the reap's claim)
  const stamps = ids.map((id) => id.slice(2, 11));
  const sorted = [...stamps].sort();
  expect(stamps).toEqual(sorted);
  expect(new Set(stamps).size).toBe(stamps.length);
});

test("reportPath refuses everything that is not one of our ids", () => {
  expect(reportPath("/d", "r-abc-def")).toBe("/d/r-abc-def.json");
  expect(reportPath("/d", "../etc/passwd")).toBeNull();
  expect(reportPath("/d", "r-abc-def/../../x")).toBeNull();
  expect(reportPath("/d", "r-ABC-def")).toBeNull();  // upper case is not ours
  expect(reportPath("/d", "")).toBeNull();
  expect(reportPath("/d", "r--")).toBeNull();
});

test("reportText scrubs control characters and bounds length", () => {
  expect(reportText("a\u0000\u0001b\u001fc", 100)).toBe("a b c");
  expect(reportText("x".repeat(50), 10)).toBe("x".repeat(10));
  expect(reportText(null, 10)).toBe("");
  expect(reportText(42, 10)).toBe("42");
});

test("reportFiles: newest first, foreign files ignored, missing dir is empty", async () => {
  const dir = await scratch();
  await writeFile(join(dir, "r-000000001-aaaaa.json"), "{}");
  await writeFile(join(dir, "r-000000002-bbbbb.json"), "{}");
  await writeFile(join(dir, "not-a-report.txt"), "x");
  await writeFile(join(dir, "r-junk.txt"), "x");
  expect(await reportFiles(dir)).toEqual([
    "r-000000002-bbbbb.json", "r-000000001-aaaaa.json",
  ]);
  expect(await reportFiles(join(dir, "never-made"))).toEqual([]);
});

test("reapReports keeps the newest `keep` and deletes the oldest", async () => {
  const dir = await scratch();
  for (let i = 1; i <= 7; i++) {
    await writeFile(join(dir, `r-00000000${i}-aaaaa.json`), "{}");
  }
  const gone = await reapReports(dir, 5);
  expect(gone).toBe(2);
  const left = (await readdir(dir)).sort();
  expect(left).toEqual([
    "r-000000003-aaaaa.json", "r-000000004-aaaaa.json", "r-000000005-aaaaa.json",
    "r-000000006-aaaaa.json", "r-000000007-aaaaa.json",
  ]);
});
