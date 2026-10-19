import { test, expect, beforeEach } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import { makeGrokUsageReader, parseGrokReset } from "./grok-usage.ts";

let cacheFile: string;
const NOW = new Date(2026, 11, 31, 23, 0).getTime();
beforeEach(async () => {
  const dir = await tmpDir("extra-usage-");
  cacheFile = join(dir, "grok.json");
});
const grok = () => makeGrokUsageReader({ cacheFile, now: () => NOW });
const cache = (data: unknown) => writeFileSync(cacheFile, JSON.stringify(data));
test("Grok fresh zero is real, freshness comes from ts, and reader does not write", async () => {
  cache({ ts: NOW / 1000 - 120, weekly_pct: 0, reset: "January 2, 22:43" });
  const before = readFileSync(cacheFile, "utf8");
  const out = await grok().read(false);
  expect(out.ok).toBe(true); expect(out.provider).toBe("grok"); expect(out.email).toBeUndefined();
  expect(out.fetchedAt).toBe(NOW - 120_000); expect(out.windows?.[0].pct).toBe(0);
  expect(readFileSync(cacheFile, "utf8")).toBe(before);
});
test("Grok stale, missing and unparseable fail without a percentage", async () => {
  expect((await grok().read(false)).ok).toBe(false);
  for (const data of [
    { ts: NOW / 1000 - 1801, weekly_pct: 0, reset: "January 2, 22:43" },
    { ts: NOW / 1000, weekly_pct: "0", reset: "January 2, 22:43" },
    { ts: NOW / 1000, weekly_pct: 0, reset: "February 30, 22:43" },
  ]) {
    cache(data); const out = await grok().read(false);
    expect(out.ok).toBe(false); expect(out.windows).toBeUndefined(); expect(out.error).toBeTruthy();
  }
  writeFileSync(cacheFile, "{"); expect((await grok().read(false)).ok).toBe(false);
});
test("Grok reset is the next local occurrence across year boundaries", () => {
  expect(parseGrokReset("January 2, 22:43", NOW)).toBe(new Date(2027, 0, 2, 22, 43).toISOString());
  expect(parseGrokReset("December 31, 22:43", NOW)).toBe(new Date(2027, 11, 31, 22, 43).toISOString());
  expect(parseGrokReset("December 31, 23:43", NOW)).toBe(new Date(2026, 11, 31, 23, 43).toISOString());
  expect(parseGrokReset("October 99, 22:43", NOW)).toBeNull();
});
