/* sealPushItem: the v2 push seal, proven against the
 * pure crypto primitives it wires together. No engine boots here: the function
 * under test takes an E2EState, so everything the brief wants proven is one
 * loadOrCreateE2E (or a mutated state) away.
 *
 * What a wrong answer looks like: a notification that opens on the phone with
 * the wrong key (silence, or the generic fallback where a real preview should
 * be), or a `enc` blob that still has his chat text legible inside it. Both are
 * asserted below rather than assumed from the fact that a seal happened.
 *
 *   bun test agent-engine/src/security/sealpush.test.ts
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { sealEngineItem, sealPushItem } from "./sealpush";
import { loadOrCreateE2E, newestGen, type ContentGen } from "./sec";
import {
  b64decode,
  b64encode,
  deriveEngineNotifyKey,
  deriveSessionKey,
  importEngineKey,
  keyId,
  openPush,
  randomBytes,
} from "../../../shared/e2e";

async function scratch(): Promise<string> {
  const { root } = await tmpDataDir("sealpush-");
  return join(root, "data", "keys.json");
}

async function makeGen(gen: number): Promise<ContentGen> {
  const keyBytes = randomBytes(32);
  return { gen, kid: await keyId(keyBytes), keyBytes, key: await importEngineKey(keyBytes), createdAt: Date.now(), retiredAt: null };
}

test("seals under the newest generation; openPush recovers the exact payload", async () => {
  const st = await loadOrCreateE2E(await scratch());
  st.content.push(await makeGen(2));

  const payload = { title: "probe chat", body: "a real preview", count: 7 };
  const sealed = await sealPushItem(st, "sess-1", payload.title, payload.body, payload.count);
  expect(sealed).not.toBeNull();
  expect(sealed!.kid).toBe(newestGen(st).kid);

  const kS = await deriveSessionKey(newestGen(st).key, "sess-1");
  expect(await openPush(kS, sealed!.enc)).toEqual(payload);
});

test("the wire carries exactly {kid, enc}, and the kid is the one that names the key", async () => {
  /* kid rides in the clear so a device holding several engines' keys picks the
   * right one without trying them all. It must be the kid OF the key that
   * sealed this, not the newest kid the engine happens to know. */
  const st = await loadOrCreateE2E(await scratch());
  const sealed = await sealPushItem(st, "sess-1", "t", "b", 1);
  expect(Object.keys(sealed).sort()).toEqual(["enc", "kid"]);
  expect(sealed.kid).toBe(await keyId(newestGen(st).keyBytes));
  expect(sealed.kid).toMatch(/^[A-Za-z0-9_-]{11}$/);
  expect(typeof sealed.enc).toBe("string");
});

test("nothing of the preview is legible in the sealed blob", async () => {
  /* The whole reason this function exists. The visible push carries a generic
   * fallback and the real title/body ride ONLY inside `enc`; a seal that left
   * either in the clear would put his chat text through APNs in plaintext.
   * Checked over the decoded bytes, not the base64, so an accidental
   * concatenation would still be caught. */
  const st = await loadOrCreateE2E(await scratch());
  const sealed = await sealPushItem(st, "sess-1", "invoice from Acme", "wire the 40k today", 2);
  const raw = new TextDecoder("latin1").decode(b64decode(sealed.enc));
  for (const secret of ["invoice", "Acme", "wire the 40k", "title", "body", "count"]) {
    expect(raw.includes(secret), secret).toBe(false);
  }
  // and the ciphertext is longer than the IV: something was actually sealed
  expect(b64decode(sealed.enc).length).toBeGreaterThan(12 + 16);
});

test("the same payload never seals to the same bytes twice", async () => {
  /* Random IV per push. Identical ciphertext for identical text would tell
   * anyone watching the transport that the same notification repeated, which
   * for a chat preview is most of the content. */
  const st = await loadOrCreateE2E(await scratch());
  const a = await sealPushItem(st, "sess-1", "t", "b", 1);
  const b = await sealPushItem(st, "sess-1", "t", "b", 1);
  expect(a.enc).not.toBe(b.enc);
  expect(a.kid).toBe(b.kid);
  const kS = await deriveSessionKey(newestGen(st).key, "sess-1");
  expect(await openPush(kS, a.enc)).toEqual(await openPush(kS, b.enc));
});

test("a payload sealed under gen N does not open with gen M's key", async () => {
  const st = await loadOrCreateE2E(await scratch());
  st.content.push(await makeGen(2)); // newest = gen 2

  const sealed = await sealPushItem(st, "sess-1", "t", "b", 1);
  expect(sealed).not.toBeNull();

  // gen 1 is a different generation: its per-session key must NOT open it
  const wrongKS = await deriveSessionKey(st.content[0].key, "sess-1");
  await expect(openPush(wrongKS, sealed!.enc)).rejects.toThrow();
});

test("a push for one session does not open with another session's key", async () => {
  /* Per-session keys are what makes handing over one session safe. If the
   * derivation ignored the session id, sharing one conversation would share
   * every notification the engine ever sealed. */
  const st = await loadOrCreateE2E(await scratch());
  const sealed = await sealPushItem(st, "sess-1", "t", "b", 1);
  await expect(openPush(await deriveSessionKey(newestGen(st).key, "sess-2"), sealed.enc)).rejects.toThrow();
  await expect(openPush(await deriveSessionKey(newestGen(st).key, ""), sealed.enc)).rejects.toThrow();
});

test("a tampered blob fails the tag rather than opening as something else", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const sealed = await sealPushItem(st, "sess-1", "t", "b", 1);
  const kS = await deriveSessionKey(newestGen(st).key, "sess-1");

  const bytes = b64decode(sealed.enc);
  bytes[bytes.length - 1] ^= 0xff; // flip a bit of the GCM tag
  await expect(openPush(kS, b64encode(bytes))).rejects.toThrow();

  const ivFlipped = b64decode(sealed.enc);
  ivFlipped[0] ^= 0xff; // flip a bit of the IV
  await expect(openPush(kS, b64encode(ivFlipped))).rejects.toThrow();

  // truncated to less than an IV: refused, never half-read
  await expect(openPush(kS, b64encode(bytes.subarray(0, 8)))).rejects.toThrow();
});

test("seals under the newest LIVE generation, not a retired newer one", async () => {
  const st = await loadOrCreateE2E(await scratch());
  st.content.push(await makeGen(2));
  st.content[1].retiredAt = Date.now(); // gen 2 retired; gen 1 stays live

  const sealed = await sealPushItem(st, "sess-1", "t", "b", 1);
  expect(sealed).not.toBeNull();
  expect(sealed!.kid).toBe(st.content[0].kid);

  const kS = await deriveSessionKey(st.content[0].key, "sess-1");
  expect(await openPush(kS, sealed!.enc)).toEqual({ title: "t", body: "b", count: 1 });
});

test("with every generation retired it still seals, under the last row", async () => {
  /* newestGen's documented fallback. A push is better sealed under a key the
   * device probably still holds than not sent at all; the alternative here is
   * a throw, and the caller treats a throw as "send nothing". */
  const st = await loadOrCreateE2E(await scratch());
  st.content.push(await makeGen(2));
  for (const c of st.content) c.retiredAt = Date.now();

  const sealed = await sealPushItem(st, "sess-1", "t", "b", 1);
  expect(sealed.kid).toBe(st.content[st.content.length - 1].kid);
  const kS = await deriveSessionKey(st.content[st.content.length - 1].key, "sess-1");
  expect(await openPush(kS, sealed.enc)).toEqual({ title: "t", body: "b", count: 1 });
});

test("the payload survives verbatim: empty strings, unicode, and a zero count", async () => {
  /* The title and body are user text and go straight onto a lock screen. A
   * codec that dropped an emoji or coerced 0 to "" would be invisible in every
   * test that only checks that SOMETHING opened. */
  const st = await loadOrCreateE2E(await scratch());
  const kS = await deriveSessionKey(newestGen(st).key, "sess-1");
  for (const payload of [
    { title: "", body: "", count: 0 },
    { title: "Ünïcödé 🔐", body: "line one\nline two\t\"quoted\"", count: 1 },
    { title: "a".repeat(4000), body: "b".repeat(4000), count: 999_999 },
  ]) {
    const sealed = await sealPushItem(st, "sess-1", payload.title, payload.body, payload.count);
    expect(await openPush(kS, sealed.enc)).toEqual(payload);
  }
});

test("no content generation throws (the caller must fail the push, send nothing)", async () => {
  const st = await loadOrCreateE2E(await scratch());
  st.content = [];
  await expect(sealPushItem(st, "sess-1", "t", "b", 1)).rejects.toThrow();
});

/* ---- the session-LESS engine seal (a plan-usage threshold alert) ---- */

test("sealEngineItem round-trips through the ENGINE notify key, carrying the tap target", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const sealed = await sealEngineItem(st, "93% of the 5-hour limit", "sam@example.com · resets soon", "usage:linux");
  expect(sealed.kid).toBe(newestGen(st).kid);
  const kN = await deriveEngineNotifyKey(newestGen(st).key);
  expect(await openPush(kN, sealed.enc)).toEqual({
    title: "93% of the 5-hour limit", body: "sam@example.com · resets soon", open: "usage:linux",
  });
});

test("an engine seal does NOT open with any session key, and a session seal not with the engine key", async () => {
  /* Domain separation is the whole point of a session-less alert: the engine key
   * (info "notify") and every per-session key (info "session:<id>") are HKDF
   * siblings that cannot open each other's blobs, so a threshold alert and a chat
   * preview are never interchangeable on a device. */
  const st = await loadOrCreateE2E(await scratch());
  const engineSealed = await sealEngineItem(st, "t", "b", "usage:host");
  // no session key opens the engine blob, empty sessionId included
  await expect(openPush(await deriveSessionKey(newestGen(st).key, ""), engineSealed.enc)).rejects.toThrow();
  await expect(openPush(await deriveSessionKey(newestGen(st).key, "sess-1"), engineSealed.enc)).rejects.toThrow();
  // and the engine key does not open a session-sealed push
  const sessionSealed = await sealPushItem(st, "sess-1", "t", "b", 1);
  await expect(openPush(await deriveEngineNotifyKey(newestGen(st).key), sessionSealed.enc)).rejects.toThrow();
});

test("sealEngineItem omits `open` when there is no tap target", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const sealed = await sealEngineItem(st, "t", "b");
  const kN = await deriveEngineNotifyKey(newestGen(st).key);
  expect(await openPush(kN, sealed.enc)).toEqual({ title: "t", body: "b" });
});

test("no content generation throws for the engine seal too (send nothing)", async () => {
  const st = await loadOrCreateE2E(await scratch());
  st.content = [];
  await expect(sealEngineItem(st, "t", "b", "usage:h")).rejects.toThrow();
});
