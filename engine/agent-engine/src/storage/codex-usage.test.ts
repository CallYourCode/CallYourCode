import { test, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import { makeCodexUsageReader, CODEX_USAGE_TTL_MS } from "./codex-usage.ts";

let dir: string, authFile: string, cacheFile: string;
const NOW = 1_800_000_000_000;
function auth(accountId = "pi-active", email = "pi@example.test") {
  const access = `fake.${Buffer.from(JSON.stringify({ email, exp: NOW / 1000 + 3600 })).toString("base64url")}.fake`;
  writeFileSync(authFile, JSON.stringify({ "openai-codex": { access, accountId } }));
  return access;
}
const weekly = { used_percent: 38, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 };
const short = { used_percent: 99, limit_window_seconds: 18000, reset_at: NOW / 1000 + 3600 };
function cache(accounts: unknown[], ts = NOW / 1000 - 60) {
  writeFileSync(cacheFile, JSON.stringify({ ts, accounts }));
}
beforeEach(async () => {
  dir = await tmpDir("codex-usage-"); authFile = join(dir, "pi-auth.json"); cacheFile = join(dir, "cache.json"); auth();
});
const reader = () => makeCodexUsageReader({ authFile, cacheFile, now: () => NOW,
  fetch: (() => { throw new Error("cache must not fetch"); }) as unknown as typeof fetch });

test("active Pi identity, not CLI source; exact accountId beats email; original per-account time; no writes", async () => {
  // Deliberately different CLI identity is not an input to this reader.
  writeFileSync(join(dir, "cli-auth.json"), JSON.stringify({ tokens: { account_id: "cli-other" } }));
  cache([{ accountId: "cli-other", email: "pi@example.test", windows: [short] },
    { accountId: "pi-active", email: "renamed@example.test", fetchedAt: NOW / 1000 - 180, windows: [weekly, short] }]);
  const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]);
  const r = await reader().read(false);
  expect(r.ok).toBe(true); expect(r.accountId).toBe("pi-active"); expect(r.email).toBe("pi@example.test");
  expect(r.fetchedAt).toBe(NOW - 180_000); expect(r.windows).toHaveLength(1); expect(r.windows![0].pct).toBe(38);
  expect(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")])).toEqual(before);
});

test("legacy email fallback is case-insensitive, but never matches an explicitly different accountId", async () => {
  cache([{ email: "PI@EXAMPLE.TEST", windows: [weekly] }]); expect((await reader().read(false)).ok).toBe(true);
  cache([{ accountId: "wrong", email: "pi@example.test", windows: [weekly] }]);
  const r = await reader().read(false); expect(r.ok).toBe(false); expect(r.windows).toBeUndefined(); expect(r.error).toContain("match");
});

test("unmatched, expired per-account, error, malformed, missing weekly never claim zero or retain old usage", async () => {
  const r = reader();
  cache([{ accountId: "pi-active", windows: [weekly] }]); expect((await r.read(false)).ok).toBe(true);
  for (const a of [
    { accountId: "wrong", windows: [weekly] },
    { accountId: "pi-active", fetchedAt: (NOW - CODEX_USAGE_TTL_MS) / 1000, windows: [weekly] },
    { accountId: "pi-active", error: "token expired", windows: [weekly] },
    { accountId: "pi-active", windows: [short] },
    { accountId: "pi-active", windows: [{ ...weekly, used_percent: null }] },
  ]) {
    cache([a]); const out = await r.read(false); expect(out.ok).toBe(false); expect(out.windows).toBeUndefined(); expect(out.error).toBeTruthy();
  }
  writeFileSync(cacheFile, "{bad"); expect((await r.read(false)).ok).toBe(false);
});

test("Pi account switch follows cache without retaining prior percentages", async () => {
  cache([{ accountId: "pi-active", windows: [weekly] }, { accountId: "next", windows: [{ ...weekly, used_percent: 7 }] }]);
  const r = reader(); const key = r.identity(); expect((await r.read(false)).windows![0].pct).toBe(38);
  auth("next", "next@example.test"); expect(r.identity()).not.toBe(key); expect((await r.read(false)).windows![0].pct).toBe(7);
  auth("unknown", "unknown@example.test"); expect((await r.read(false)).ok).toBe(false);
});

test("missing cache fallback is one bounded read-only GET with Pi credentials; weekly by duration in either position", async () => {
  const access = auth(); const original = readFileSync(authFile, "utf8"); let calls = 0;
  const r = makeCodexUsageReader({ authFile, cacheFile, now: () => NOW, fetch: (async (url, init) => {
    calls++; expect(url).toBe("https://chatgpt.com/backend-api/wham/usage"); expect(init?.method).toBe("GET");
    expect(init?.signal).toBeDefined(); expect(init?.headers).toEqual({ Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": "pi-active", "User-Agent": "codex_cli_rs" });
    return Response.json({ rate_limit: calls === 1 ? { primary_window: weekly } : { primary_window: short, secondary_window: weekly } });
  }) as typeof fetch });
  expect((await r.read(false)).windows![0].pct).toBe(38); await r.read(false); expect(calls).toBe(1);
  expect((await r.read(true)).windows).toHaveLength(1); expect(calls).toBe(2);
  expect(readFileSync(authFile, "utf8")).toBe(original); expect(readdirSync(dir)).toEqual(["pi-auth.json"]);
});

test("absent configuration also falls back, HTTP errors never turn into zero", async () => {
  const old = process.env.CYC_CODEX_USAGE_CACHE; delete process.env.CYC_CODEX_USAGE_CACHE;
  try {
    const r = makeCodexUsageReader({ authFile, now: () => NOW,
      fetch: (async () => new Response("refused", { status: 401 })) as typeof fetch });
    const out = await r.read(false); expect(out.ok).toBe(false); expect(out.windows).toBeUndefined(); expect(out.error).toContain("401");
  } finally { if (old !== undefined) process.env.CYC_CODEX_USAGE_CACHE = old; }
});

test("present stale/error/unmatched cache is authoritative and cannot trigger extra GET polling", async () => {
  let calls = 0;
  const r = makeCodexUsageReader({ authFile, cacheFile, now: () => NOW, fetch: (async () => {
    calls++; return Response.json({ rate_limit: { primary_window: weekly } });
  }) as typeof fetch });
  cache([{ accountId: "pi-active", fetchedAt: (NOW - CODEX_USAGE_TTL_MS) / 1000, windows: [weekly] }]);
  expect((await r.read(true)).error).toContain("expired");
  cache([{ accountId: "pi-active", error: "token expired" }]); expect((await r.read(true)).error).toContain("token expired");
  cache([{ accountId: "other", windows: [weekly] }]); expect((await r.read(true)).error).toContain("match");
  expect(calls).toBe(0);
});

test("old-account in-flight fallback cannot poison new-account cache", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  const r = makeCodexUsageReader({ authFile, cacheFile, now: () => NOW, fetch: (async () => {
    calls++;
    return calls === 1 ? new Promise<Response>((resolve) => { release = resolve; })
      : Response.json({ rate_limit: { primary_window: { ...weekly, used_percent: 7 } } });
  }) as typeof fetch });
  const old = r.read(false);
  auth("next", "next@example.test");
  expect((await r.read(false)).windows![0].pct).toBe(7);
  release(Response.json({ rate_limit: { primary_window: weekly } })); await old;
  const next = await r.read(false); expect(next.accountId).toBe("next"); expect(next.windows![0].pct).toBe(7); expect(calls).toBe(2);
});
