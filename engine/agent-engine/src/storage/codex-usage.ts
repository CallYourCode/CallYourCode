/* Read-only active Pi Codex usage. No CLI symlinks, refresh, rotation or auth writes.
 * A configured monitor cache is authoritative when present; only an absent cache
 * falls back to one bounded GET, cached for fifteen minutes per active identity. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { UsageReport, CodexUsageReader } from "../plugins/usage-card/index.ts";

export const CODEX_USAGE_TTL_MS = 15 * 60_000;
type Identity = { accountId: string; email?: string; access: string; expires?: number; key: string };
type Window = { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown };
type Account = { accountId?: string; email?: string; acct?: string; plan?: string; error?: string; fetchedAt?: number; ts?: number; windows?: Window[] };
export type CodexUsageOptions = {
  authFile?: string;
  cacheFile?: string;
  now?: () => number;
  fetch?: typeof fetch;
};

export function makeCodexUsageReader(opts: CodexUsageOptions = {}): CodexUsageReader {
  const now = opts.now ?? Date.now;
  const authFile = () => opts.authFile ?? process.env.CYC_PI_AUTH_FILE ?? join(homedir(), ".pi", "agent", "auth.json");
  const cacheFile = () => opts.cacheFile ?? process.env.CYC_CODEX_USAGE_CACHE;
  const identity = (): Identity | null => {
    try {
      const auth = JSON.parse(readFileSync(authFile(), "utf8"))["openai-codex"];
      if (typeof auth?.accountId !== "string" || !auth.accountId || typeof auth.access !== "string" || !auth.access) return null;
      const claims = JSON.parse(Buffer.from(auth.access.split(".")[1], "base64url").toString());
      const email = claims["https://api.openai.com/profile"]?.email ?? claims.email;
      const normalized = typeof email === "string" ? email.toLowerCase() : undefined;
      const key = createHash("sha256").update(JSON.stringify([auth.accountId, normalized])).digest("hex");
      return { accountId: auth.accountId, email: normalized, access: auth.access, expires: claims.exp, key };
    } catch { return null; }
  };
  const failure = (id: Identity | null, error: string, fetchedAt = NaN): UsageReport => ({
    ok: false, provider: "codex", email: id?.email, accountId: id?.accountId,
    error, reason: id ? "unknown" : "signed-out", fetchedAt,
  });
  const report = (id: Identity, a: Account, ts: number): UsageReport => {
    const fetchedAt = ts * 1000;
    if (!Number.isFinite(fetchedAt) || fetchedAt > now() || now() - fetchedAt >= CODEX_USAGE_TTL_MS)
      return failure(id, "Codex usage cache expired or undated", fetchedAt);
    if (a.error) return failure(id, `Codex usage unavailable: ${a.error}`, fetchedAt);
    const weekly = (a.windows ?? []).filter((w) => w.limit_window_seconds === 604800);
    if (!weekly.length) return failure(id, "Codex weekly limit unavailable", fetchedAt);
    if (weekly.some((w) => typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent) ||
      typeof w.reset_at !== "number" || !Number.isFinite(w.reset_at) || !Number.isFinite(new Date(w.reset_at * 1000).getTime())))
      return failure(id, "Codex weekly limit is invalid", fetchedAt);
    return { ok: true, provider: "codex", accountId: id.accountId, email: id.email ?? a.email,
      plan: a.plan, fetchedAt, windows: weekly.map((w) => ({ label: "week", pct: w.used_percent as number,
        resetsAt: new Date((w.reset_at as number) * 1000).toISOString() })) };
  };
  let memo: { key: string; at: number; report: UsageReport } | null = null;
  let pending: { key: string; promise: Promise<UsageReport> } | null = null;
  return {
    identity: () => identity()?.key ?? "signed-out",
    async read(force) {
      const id = identity();
      if (!id) return failure(null, "Active Pi Codex account is not signed in");
      const path = cacheFile();
      if (path) {
        let raw: string | undefined;
        try { raw = readFileSync(path, "utf8"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return failure(id, "Codex usage cache unreadable"); }
        if (raw !== undefined) {
          try {
            const cache = JSON.parse(raw);
            if (!Array.isArray(cache.accounts)) return failure(id, "Codex usage cache invalid");
            const accounts = cache.accounts as Account[];
            const exact = accounts.filter((a) => a.accountId === id.accountId);
            const matches = exact.length ? exact : accounts.filter((a) => !a.accountId && id.email && a.email?.toLowerCase() === id.email);
            if (matches.length !== 1) return failure(id, "Codex usage cache has no unique match for active Pi account");
            const a = matches[0];
            return report(id, a, a.fetchedAt ?? a.ts ?? cache.ts);
          } catch { return failure(id, "Codex usage cache invalid"); }
        }
      }
      if (memo?.key !== id.key) memo = null;
      if (pending?.key === id.key) return pending.promise;
      if (!force && memo && now() - memo.at < CODEX_USAGE_TTL_MS) return memo.report;
      const promise = (async () => {
        if (typeof id.expires === "number" && id.expires * 1000 <= now()) return failure(id, "Active Pi Codex access token expired");
        try {
          const response = await (opts.fetch ?? fetch)("https://chatgpt.com/backend-api/wham/usage", {
            method: "GET", headers: { Authorization: `Bearer ${id.access}`, "ChatGPT-Account-Id": id.accountId,
              "User-Agent": "codex_cli_rs" }, signal: AbortSignal.timeout(6_000), redirect: "error",
          });
          if (!response.ok) return failure(id, `Codex usage HTTP ${response.status}`);
          const text = await response.text();
          if (text.length > 128 * 1024) return failure(id, "Codex usage response too large");
          const data = JSON.parse(text);
          const rl = data.rate_limit ?? {};
          const result = report(id, { plan: data.plan_type,
            windows: [rl.primary_window, rl.secondary_window].filter(Boolean) }, now() / 1000);
          return result;
        } catch { return failure(id, "Could not reach Codex usage service"); }
      })();
      const flight = { key: id.key, promise };
      pending = flight;
      try {
        const result = await promise;
        if (identity()?.key === id.key) memo = { key: id.key, at: now(), report: result };
        return result;
      } finally { if (pending === flight) pending = null; }
    },
  };
}
