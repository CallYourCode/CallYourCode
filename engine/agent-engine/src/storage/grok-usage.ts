/* Read-only external Grok usage cache. There is no credential or network fallback. */
import { readFileSync } from "node:fs";
import type { UsageReader, UsageReport } from "../plugins/usage-card/index.ts";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const GROK_USAGE_TTL_MS = 30 * 60_000;

/** The monitor's yearless reset is local time. Reject rollover dates, not just invalid Date values. */
export function parseGrokReset(value: unknown, now: number): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\w+) (\d{1,2}), (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  const day = Number(match[2]), hour = Number(match[3]), minute = Number(match[4]);
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const year = new Date(now).getFullYear();
  // Include the next leap year for a February 29 reset.
  for (let y = year; y <= year + 4; y++) {
    const date = new Date(y, month, day, hour, minute);
    if (date.getMonth() === month && date.getDate() === day && date.getHours() === hour &&
      date.getMinutes() === minute && date.getTime() > now) return date.toISOString();
  }
  return null;
}

export function makeGrokUsageReader(opts: { cacheFile?: string; now?: () => number } = {}): UsageReader {
  const path = () => opts.cacheFile ?? process.env.CYC_GROK_USAGE_CACHE;
  const now = opts.now ?? Date.now;
  const failure = (error: string, fetchedAt = NaN): UsageReport => ({ ok: false, provider: "grok", error, fetchedAt });
  return {
    identity: () => path() ?? "unconfigured",
    async read() {
      const file = path();
      if (!file) return failure("Grok usage cache is not configured");
      let data;
      try { data = JSON.parse(readFileSync(file, "utf8")); }
      catch { return failure("Grok usage cache missing, unreadable or invalid"); }
      const fetchedAt = typeof data?.ts === "number" ? data.ts * 1000 : NaN;
      const at = now();
      if (!Number.isFinite(fetchedAt) || fetchedAt > at || at - fetchedAt > GROK_USAGE_TTL_MS)
        return failure("Grok usage cache stale or undated", fetchedAt);
      const resetsAt = parseGrokReset(data.reset, at);
      if (typeof data.weekly_pct !== "number" || !Number.isFinite(data.weekly_pct) || data.weekly_pct < 0 || !resetsAt)
        return failure("Grok usage cache invalid percentage or reset", fetchedAt);
      return { ok: true, provider: "grok", fetchedAt, windows: [{ label: "week", pct: data.weekly_pct, resetsAt }] };
    },
  };
}
