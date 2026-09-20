/* THE FROZEN v3 CRYPTO VECTORS for e2e.ts, plus the branches around them.
 *
 * Renamed from `e2e.test.ts` in the suite rewrite: the name `e2e` now belongs
 * to the boot tier (agent-engine/src/e2e/, the only four files allowed to start an
 * engine), and a pure-unit file sitting on that name made "run the e2e tests"
 * mean two different things. Nothing about the subject changed: this is still
 * the drift pin for the shared crypto core, and every assertion it had is
 * still here.
 *
 * What it pins: fp derivation and its display form, the ECDH -> kRoot ->
 * frame-key chain, the sec (engine) and sec-ok (device) signatures, replay
 * refusal in FrameReceiver, SecureChannel open/accept, and sealBlob at rest.
 *
 * The vectors are computed ONCE (from freshly generated keys) into the single
 * shared copy engine/shared/fixtures/e2e-vectors.json, then frozen. The crypto
 * is one shared module (engine/shared/e2e.ts) imported by both the engine and
 * the app bundle, and the app test asserts the SAME fixture, so a drift in the
 * derivation on either side fails a test instead of silently breaking sealing
 * between an engine and an app built at different times.
 *
 * Deterministic things (fp, the ECDH -> frame-key -> sealed-frame chain from
 * fixed ephemerals, the blob open) are pinned BY VALUE. ECDSA signatures use a
 * random k, so they are pinned by VERIFYING the frozen signature rather than
 * re-signing.
 */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  b64encode,
  b64decode,
  b64urlencode,
  b64urldecode,
  randomBytes,
  keyId,
  fpOf,
  fpOfSpki,
  fpDisplay,
  exportSpki,
  importSpkiVerify,
  generateIdentity,
  newIdentity,
  signId,
  verifyId,
  secTranscript,
  importEcdhPoint,
  ecdhRoot,
  deriveAuthKey,
  handshakeTag,
  verifyHandshakeTag,
  derivePairKey,
  secPairTag,
  verifySecPairTag,
  deriveFrameKey,
  deriveSessionKey,
  deriveEngineNotifyKey,
  sealFrame,
  openFrame,
  sealPush,
  openPush,
  importEngineKey,
  deriveBlobKey,
  sealBlob,
  openBlob,
  blobGen,
  SecureChannel,
  FrameReceiver,
  FrameSender,
} from "../../../shared/e2e";

const FIXTURE = new URL("../../../shared/fixtures/e2e-vectors.json", import.meta.url).pathname;
const te = new TextEncoder();

type Jwk = JsonWebKey;
const importEcdhPriv = (jwk: Jwk) =>
  crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const exportJwk = (k: CryptoKey) => crypto.subtle.exportKey("jwk", k) as Promise<Jwk>;
const rawOf = async (k: CryptoKey) => b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", k)));

async function computeVectors() {
  // engine + device identities (ECDSA P-256)
  const idKp = await generateIdentity(true);
  const spki = await exportSpki(idKp.publicKey);
  const fp = await fpOf(idKp.publicKey);
  const devKp = await generateIdentity(true);
  const devSpki = await exportSpki(devKp.publicKey);

  // fixed ephemerals (ECDH) + nonces
  const engEph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const devEph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ce = await rawOf(devEph.publicKey); // device ephemeral point
  const ee = await rawOf(engEph.publicKey); // engine ephemeral point
  const cn = b64encode(randomBytes(16));
  const en = b64encode(randomBytes(16));

  // frozen signatures
  const secSig = b64encode(await signId(idKp.privateKey, te.encode(secTranscript("e", ce, ee, cn, en))));
  const secokSig = b64encode(
    await signId(devKp.privateKey, te.encode(secTranscript("c", ce, ee, cn, en, spki))),
  );

  // deterministic sealed e2c frame from the fixed ECDH (engine side)
  const kRoot = await ecdhRoot(engEph.privateKey, await importEcdhPoint(b64decode(ce)));
  const kE2c = await deriveFrameKey(kRoot, "e2c", b64decode(cn), b64decode(en));
  const frameInner = { t: "sec-done", fp, paired: false };
  const sealed = await sealFrame(kE2c, "e2c", 0, frameInner);

  // content key + a sealed blob at rest
  const contentKey = randomBytes(32);
  const kBlob = await deriveBlobKey(await importEngineKey(contentKey));
  const blobPt = b64encode(te.encode("note 1"));
  const blob = b64encode(await sealBlob(kBlob, 7, b64decode(blobPt)));

  // the engine-level (session-LESS) notify key, and a frozen sealed blob under it
  const kNotify = await deriveEngineNotifyKey(await importEngineKey(contentKey));
  const engineNotifyPt = { title: "93% of the 5-hour limit", body: "sam@example.com · resets soon", open: "usage:linux" };
  const engineNotifyBlob = await sealPush(kNotify, engineNotifyPt);

  return {
    v: 2,
    identity: { spki, fp, fpDisplay: fpDisplay(fp) },
    deviceSpki: devSpki,
    engEphJwk: await exportJwk(engEph.privateKey),
    devEphJwk: await exportJwk(devEph.privateKey),
    ce,
    ee,
    cn,
    en,
    secSig,
    secokSig,
    frameInner,
    sealed,
    contentKey: b64encode(contentKey),
    blobGen: 7,
    blob,
    blobPt,
    engineNotifyPt,
    engineNotifyBlob,
  };
}

function loadFixture() {
  if (!existsSync(FIXTURE)) return null;
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

// Generate-and-freeze on first run.
if (!existsSync(FIXTURE)) {
  mkdirSync(new URL("../fixtures/", import.meta.url).pathname, { recursive: true });
  const v = await computeVectors();
  writeFileSync(FIXTURE, JSON.stringify(v, null, 2) + "\n");
}
const V = loadFixture();

/* The frozen channel, rebuilt from the fixture's fixed ephemerals. Both the
 * engine and the device derive it; every frame test below hangs off it. */
async function frozenFrameKeys() {
  const engEph = await importEcdhPriv(V.engEphJwk);
  const devEph = await importEcdhPriv(V.devEphJwk);
  const cn = b64decode(V.cn);
  const en = b64decode(V.en);
  const kRootE = await ecdhRoot(engEph, await importEcdhPoint(b64decode(V.ce)));
  const kRootD = await ecdhRoot(devEph, await importEcdhPoint(b64decode(V.ee)));
  return {
    cn,
    en,
    kRootE,
    kRootD,
    e2cEngine: await deriveFrameKey(kRootE, "e2c", cn, en),
    e2cDevice: await deriveFrameKey(kRootD, "e2c", cn, en),
    c2eEngine: await deriveFrameKey(kRootE, "c2e", cn, en),
  };
}

/* --- the frozen vectors --------------------------------------------------- */

test("fp and its display form derive from the frozen identity", async () => {
  const pub = await importSpkiVerify(V.identity.spki);
  expect(await fpOf(pub)).toBe(V.identity.fp);
  expect(fpDisplay(V.identity.fp)).toBe(V.identity.fpDisplay);
  expect(V.identity.fp.length).toBe(43);
  expect(V.identity.fpDisplay).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
});

test("fpOfSpki is the same derivation as fpOf, so the wire form and the key form agree", async () => {
  /* The engine hands a device an spki string and pins an fp; the two paths are
   * separate functions, and a device that computed a different fp from the same
   * key would refuse every reconnect with "identity changed". */
  expect(await fpOfSpki(V.identity.spki)).toBe(V.identity.fp);
  expect(await fpOfSpki(V.deviceSpki)).not.toBe(V.identity.fp);
  // fp is base64url of a 32 byte digest: 43 chars, no padding, no + or /
  expect(V.identity.fp).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("the ECDH -> frame-key chain opens the frozen sealed frame, both sides agreeing on kRoot", async () => {
  const k = await frozenFrameKeys();

  // the device opens the frozen frame the engine sealed
  expect(await openFrame(k.e2cDevice, "e2c", V.sealed)).toEqual(V.frameInner);
  // and re-sealing at n=0 is byte-identical (deterministic counter IV)
  expect(await sealFrame(k.e2cEngine, "e2c", 0, V.frameInner)).toEqual(V.sealed);
});

test("the frozen sec (engine) signature verifies over the e-transcript", async () => {
  const pub = await importSpkiVerify(V.identity.spki);
  const ok = await verifyId(pub, te.encode(secTranscript("e", V.ce, V.ee, V.cn, V.en)), b64decode(V.secSig));
  expect(ok).toBe(true);
  // a flipped transcript must NOT verify (binding is real)
  const bad = await verifyId(pub, te.encode(secTranscript("e", V.ce, V.ee, V.cn, V.en) + "x"), b64decode(V.secSig));
  expect(bad).toBe(false);
  /* M3 (security hardening): user/host are INSIDE the signed e-transcript
   * now, so an in-path relabel of who/where the engine claims to be breaks
   * the signature instead of riding through unnoticed. */
  const relabeled = await verifyId(pub,
    te.encode(secTranscript("e", V.ce, V.ee, V.cn, V.en, undefined, "mallory", "evil-host")),
    b64decode(V.secSig));
  expect(relabeled).toBe(false);
});

test("the frozen sec-ok (device) signature verifies over the c-transcript, binding the engine id", async () => {
  const pub = await importSpkiVerify(V.deviceSpki);
  const ok = await verifyId(
    pub,
    te.encode(secTranscript("c", V.ce, V.ee, V.cn, V.en, V.identity.spki)),
    b64decode(V.secokSig),
  );
  expect(ok).toBe(true);
  /* Unknown-key-share: the same device signature over a DIFFERENT engine id
   * must not verify, or an in-path engine could re-present the device's proof
   * as a proof about itself. */
  const other = await verifyId(
    pub,
    te.encode(secTranscript("c", V.ce, V.ee, V.cn, V.en, V.deviceSpki)),
    b64decode(V.secokSig),
  );
  expect(other).toBe(false);
  // and the engine's own key never verifies the device's signature
  const eng = await importSpkiVerify(V.identity.spki);
  expect(await verifyId(eng, te.encode(secTranscript("c", V.ce, V.ee, V.cn, V.en, V.identity.spki)),
    b64decode(V.secokSig))).toBe(false);
});

test("sealBlob/openBlob round-trips and opens the frozen blob under the frozen content key", async () => {
  const kBlob = await deriveBlobKey(await importEngineKey(b64decode(V.contentKey)));
  const blob = b64decode(V.blob);
  expect(blobGen(blob)).toBe(V.blobGen);
  expect(await openBlob(kBlob, blob)).toEqual(b64decode(V.blobPt));
  // fresh round-trip
  const bytes = te.encode("a fresh secret at rest");
  const sealed = await sealBlob(kBlob, 3, bytes);
  expect(blobGen(sealed)).toBe(3);
  expect(await openBlob(kBlob, sealed)).toEqual(bytes);
});

/* --- the transcript string itself ----------------------------------------- */

test("secTranscript binds the side, all four wire strings, and the side-specific tail", async () => {
  /* The transcript IS the security of the handshake: everything a signature
   * covers is in this one string. A field silently dropped from it would still
   * verify on both sides and still be forgeable in the middle, so the shape is
   * asserted literally rather than by re-deriving it. */
  expect(secTranscript("e", "CE", "EE", "CN", "EN", undefined, "example", "linux"))
    .toBe("cyc-sec-v2|e|CE|EE|CN|EN|example|linux");
  expect(secTranscript("c", "CE", "EE", "CN", "EN", "ID"))
    .toBe("cyc-sec-v2|c|CE|EE|CN|EN|ID");
  // the two sides are never the same string, so a c-side proof is not an e-side one
  expect(secTranscript("e", "a", "b", "c", "d")).not.toBe(secTranscript("c", "a", "b", "c", "d"));
  // absent user/host are empty fields, not absent fields: the separators stay
  expect(secTranscript("e", "a", "b", "c", "d")).toBe("cyc-sec-v2|e|a|b|c|d||");
});

/* --- base64 / base64url --------------------------------------------------- */

test("base64 round-trips every byte value at every padding boundary", async () => {
  /* This codec is hand-rolled (no Buffer, no atob) because the same file runs
   * in the service worker. A byte it mangles is a key it mangles. */
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  expect(b64decode(b64encode(all))).toEqual(all);
  for (let n = 0; n <= 4; n++) {
    const bytes = all.subarray(0, n);
    expect(b64decode(b64encode(bytes)), `length ${n}`).toEqual(bytes);
    expect(b64urldecode(b64urlencode(bytes)), `url length ${n}`).toEqual(bytes);
  }
  // the url form is safe in a header, a filename and a query string
  expect(b64urlencode(all)).not.toMatch(/[+/=]/);
});

test("keyId is a stable 11 char base64url tag that separates two content keys", async () => {
  /* kid rides the wire in plaintext beside every sealed push so a device with
   * several engines' keys picks the right one. Two engines colliding on a kid
   * would make a device try the wrong key and drop the notification. */
  const a = randomBytes(32);
  const b = randomBytes(32);
  expect(await keyId(a)).toBe(await keyId(a));
  expect(await keyId(a)).toMatch(/^[A-Za-z0-9_-]{11}$/);
  expect(await keyId(a)).not.toBe(await keyId(b));
});

/* --- frame keys: direction and connection separation ---------------------- */

test("the two directions get different keys, so an echoed frame cannot be replayed back", async () => {
  const k = await frozenFrameKeys();
  /* dir is the HKDF info AND part of the IV. If the two directions ever shared
   * a key, an attacker could bounce the engine's own sealed frame back at it
   * and it would open as a client frame. */
  const eng = await sealFrame(k.e2cEngine, "e2c", 0, { t: "sec-done" });
  await expect(openFrame(k.c2eEngine, "c2e", eng)).rejects.toThrow();
});

test("fresh nonces make the frame keys per-connection: yesterday's frame is garbage today", async () => {
  const k = await frozenFrameKeys();
  // the same kRoot with ONE nonce byte different is a different key
  const otherCn = new Uint8Array(k.cn);
  otherCn[0] ^= 1;
  const kOther = await deriveFrameKey(k.kRootE, "e2c", otherCn, k.en);
  await expect(openFrame(kOther, "e2c", V.sealed)).rejects.toThrow();
  // and a whole different connection (different kRoot) certainly cannot
  const stranger = await deriveFrameKey(
    await importEngineKey(randomBytes(32)), "e2c", k.cn, k.en);
  await expect(openFrame(stranger, "e2c", V.sealed)).rejects.toThrow();
});

test("the counter is the IV: the same inner frame at a different n is a different ciphertext", async () => {
  const k = await frozenFrameKeys();
  const at0 = await sealFrame(k.e2cEngine, "e2c", 0, V.frameInner);
  const at1 = await sealFrame(k.e2cEngine, "e2c", 1, V.frameInner);
  expect(at1.ct).not.toBe(at0.ct);
  // and n is what the receiver rebuilds the IV from: claiming a different n breaks the tag
  await expect(openFrame(k.e2cDevice, "e2c", { ...at0, n: 1 })).rejects.toThrow();
});

test("a tampered ciphertext fails the GCM tag instead of returning garbage", async () => {
  const k = await frozenFrameKeys();
  const raw = b64decode(V.sealed.ct);
  raw[0] ^= 0xff;
  await expect(openFrame(k.e2cDevice, "e2c", { ...V.sealed, ct: b64encode(raw) })).rejects.toThrow();
});

/* --- FrameReceiver / FrameSender counters --------------------------------- */

test("FrameReceiver refuses a non-integer n outright and still refuses replays", async () => {
  const k = await frozenFrameKeys();
  const rx = new FrameReceiver(k.e2cDevice, "e2c");
  // a fractional n is >= next(0) yet not an integer; u64be would truncate it to
  // n=0's IV, so it must be refused before any decrypt
  await expect(rx.open({ ...V.sealed, n: 0.5 })).rejects.toThrow("e2e.replay");

  // n=0 still opens, then next becomes 1
  expect(await rx.open(V.sealed)).toEqual(V.frameInner);
  // a replayed n=0 is refused (strictly increasing)
  await expect(rx.open(V.sealed)).rejects.toThrow("e2e.replay");
});

test("FrameReceiver refuses a non-numeric n, the shape a hand-rolled client sends", async () => {
  const k = await frozenFrameKeys();
  const rx = new FrameReceiver(k.e2cDevice, "e2c");
  await expect(rx.open({ ...V.sealed, n: "0" as any })).rejects.toThrow("e2e.replay");
  await expect(rx.open({ ...V.sealed, n: undefined as any })).rejects.toThrow("e2e.replay");
  await expect(rx.open({ ...V.sealed, n: NaN })).rejects.toThrow("e2e.replay");
  // none of those advanced the counter: the genuine n=0 still opens
  expect(await rx.open(V.sealed)).toEqual(V.frameInner);
});

test("a forged high-n frame cannot burn counter space and wedge the real stream", async () => {
  /* The counter advances only AFTER the tag verifies. Otherwise anyone who can
   * write on the pipe sends {n: 2^40, ct: garbage} once and every genuine frame
   * afterwards is refused as a replay: a one-packet denial of service. */
  const k = await frozenFrameKeys();
  const rx = new FrameReceiver(k.e2cDevice, "e2c");
  await expect(rx.open({ t: "x", n: 1_000_000, ct: b64encode(randomBytes(48)) })).rejects.toThrow();
  expect(await rx.open(V.sealed)).toEqual(V.frameInner);
});

test("FrameReceiver serialises opens so two copies of one frame cannot race through", async () => {
  /* Decryption is async. Before the chain, two frames arriving back to back both
   * read `next`, both passed, and both advanced it: a replay slipping through.
   * Fired WITHOUT awaiting between them, exactly the way an onmessage burst
   * arrives. */
  const k = await frozenFrameKeys();
  const rx = new FrameReceiver(k.e2cDevice, "e2c");
  const results = await Promise.allSettled([rx.open(V.sealed), rx.open(V.sealed)]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect((results[1] as PromiseRejectedResult).reason.message).toBe("e2e.replay");
});

test("FrameSender counts up from zero and FrameReceiver accepts exactly that order", async () => {
  const k = await frozenFrameKeys();
  const tx = new FrameSender(k.e2cEngine, "e2c");
  const rx = new FrameReceiver(k.e2cDevice, "e2c");
  const frames = [];
  for (const inner of [{ a: 1 }, { a: 2 }, { a: 3 }]) frames.push(await tx.seal(inner));
  expect(frames.map((f) => f.n)).toEqual([0, 1, 2]);
  for (const f of frames) expect(await rx.open(f)).toEqual({ a: f.n + 1 });
  /* A GAP is allowed (strictly increasing, not contiguous): the pipe is
   * ordered and reliable, so a gap means a frame was dropped upstream, not
   * that the stream should stop. */
  const rx2 = new FrameReceiver(k.e2cDevice, "e2c");
  expect(await rx2.open(frames[2])).toEqual({ a: 3 });
  await expect(rx2.open(frames[1])).rejects.toThrow("e2e.replay");
});

/* --- SecureChannel -------------------------------------------------------- */

test("SecureChannel offer -> answer -> accept opens both directions", async () => {
  const identity = await newIdentity(true);
  const offer = await SecureChannel.offer();
  const { sec, chan: eng } = await SecureChannel.answer(offer.hello, identity, "example", "linux");
  const dev = await SecureChannel.accept(offer, sec, null);

  const up = await dev.seal({ t: "sec-ok", label: "iPhone" });
  expect(await eng.open(up)).toEqual({ t: "sec-ok", label: "iPhone" });
  const down = await eng.seal({ t: "sec-done", paired: false });
  expect(await dev.open(down)).toEqual({ t: "sec-done", paired: false });
});

test("the sec frame carries the announced identity, user and host, all signed", async () => {
  const identity = await newIdentity(true);
  const offer = await SecureChannel.offer();
  const { sec, chan } = await SecureChannel.answer(offer.hello, identity, "example", "linux");
  expect(sec.v).toBe(2);
  expect(sec.id).toBe(identity.spki);
  expect(sec.user).toBe("example");
  expect(sec.host).toBe("linux");
  // the transcript the device signs its sec-ok over is exactly the wire strings
  const t = chan.transcript();
  expect(t).toEqual({ ce: offer.hello.ce, ee: sec.ee, cn: offer.hello.cn, en: sec.en, id: identity.spki });
  // transcript() hands back a copy: a caller mutating it cannot re-point the channel
  t.id = "tampered";
  expect(chan.transcript().id).toBe(identity.spki);
});

test("accept refuses an engine whose fp is not the pinned one", async () => {
  const identity = await newIdentity(true);
  const offer = await SecureChannel.offer();
  const { sec } = await SecureChannel.answer(offer.hello, identity, "u", "h");
  await expect(SecureChannel.accept(offer, sec, "not-the-real-fp")).rejects.toThrow(/identity changed/);
});

test("accept passes when the pinned fp is this engine's, and refuses a forged sig", async () => {
  const identity = await newIdentity(true);
  const offer = await SecureChannel.offer();
  const { sec } = await SecureChannel.answer(offer.hello, identity, "u", "h");
  // the return visit: the device pins the fp it saw at first contact
  expect(await SecureChannel.accept(offer, sec, identity.fp)).toBeInstanceOf(SecureChannel);
  // a sig from the right key over the WRONG transcript is still refused
  const forged = b64encode(await signId(identity.keyPair.privateKey, te.encode("cyc-sec-v2|e|not|the|real|thing")));
  await expect(SecureChannel.accept(offer, { ...sec, sig: forged }, null)).rejects.toThrow(/bad engine sig/);
  // relabelling user/host after the fact breaks the signature (M3)
  await expect(SecureChannel.accept(offer, { ...sec, host: "evil-host" }, null)).rejects.toThrow(/bad engine sig/);
});

test("a sealed frame replayed on a live SecureChannel is refused end to end", async () => {
  const identity = await newIdentity(true);
  const offer = await SecureChannel.offer();
  const { sec, chan: eng } = await SecureChannel.answer(offer.hello, identity, "u", "h");
  const dev = await SecureChannel.accept(offer, sec, null);
  const up = await dev.seal({ t: "utterance", text: "pay the invoice" });
  expect(await eng.open(up)).toEqual({ t: "utterance", text: "pay the invoice" });
  await expect(eng.open(up)).rejects.toThrow("e2e.replay");
});

test("two independent connections never share a channel: A's frame is garbage to B", async () => {
  const identity = await newIdentity(true);
  const oa = await SecureChannel.offer();
  const ob = await SecureChannel.offer();
  const a = await SecureChannel.answer(oa.hello, identity, "u", "h");
  const b = await SecureChannel.answer(ob.hello, identity, "u", "h");
  const devA = await SecureChannel.accept(oa, a.sec, null);
  const fromA = await devA.seal({ t: "sec-ok" });
  await expect(b.chan.open(fromA)).rejects.toThrow();
});

/* --- the pairing proof and the per-session key ---------------------------- */

test("the pair proof binds both the content generation and the exact transcript", async () => {
  /* #key-required-enrol: this tag is the ONLY thing standing between an unknown
   * device and enrolment. It must fail on a different content key (a rotated
   * engine) and on a different transcript (a proof lifted from another
   * handshake and replayed here). */
  const genA = await importEngineKey(randomBytes(32));
  const genB = await importEngineKey(randomBytes(32));
  const transcript = secTranscript("c", "ce", "ee", "cn", "en", V.identity.spki);
  const other = secTranscript("c", "ce", "ee", "cn", "en2", V.identity.spki);

  const keyA = await derivePairKey(genA);
  const tag = await secPairTag(keyA, transcript);
  expect(await verifySecPairTag(keyA, transcript, tag)).toBe(true);
  expect(await verifySecPairTag(keyA, other, tag)).toBe(false);
  expect(await verifySecPairTag(await derivePairKey(genB), transcript, tag)).toBe(false);
  // deterministic: the device and the engine compute the same tag independently
  expect(await secPairTag(await derivePairKey(genA), transcript)).toBe(tag);
});

test("deriveSessionKey is per-session, so handing over one session hands over only it", async () => {
  const kEngine = await importEngineKey(randomBytes(32));
  const k1 = await deriveSessionKey(kEngine, "sess-1");
  const k2 = await deriveSessionKey(kEngine, "sess-2");
  const blob = await sealPush(k1, { title: "t", body: "b", count: 1 });
  expect(await openPush(k1, blob)).toEqual({ title: "t", body: "b", count: 1 });
  await expect(openPush(k2, blob)).rejects.toThrow();
  // stable across calls: the app re-derives it on every notification
  expect(await openPush(await deriveSessionKey(kEngine, "sess-1"), blob))
    .toEqual({ title: "t", body: "b", count: 1 });
});

test("the engine-notify key opens the frozen session-less blob, and no session key can (domain separation)", async () => {
  /* A plan-usage threshold alert is about the ACCOUNT, not a chat: it is sealed
   * under deriveEngineNotifyKey (HKDF info "notify"), which the device derives
   * precisely because the item has no sessionId. This pins that derivation and
   * proves the domain separation the whole design rests on: the SAME content
   * key's session key (info "session:<id>") must NOT open an engine blob, or an
   * engine alert and a chat push would be interchangeable. */
  const kEngine = await importEngineKey(b64decode(V.contentKey));
  const kNotify = await deriveEngineNotifyKey(kEngine);
  expect(await openPush(kNotify, V.engineNotifyBlob)).toEqual(V.engineNotifyPt);
  // a session key over the same content key cannot open it (info differs)
  await expect(openPush(await deriveSessionKey(kEngine, ""), V.engineNotifyBlob)).rejects.toThrow();
  await expect(openPush(await deriveSessionKey(kEngine, "any"), V.engineNotifyBlob)).rejects.toThrow();
});

test("sealPush uses a random IV, so the same payload never seals to the same bytes", async () => {
  /* Unlike a frame, a push has no counter to make an IV from: it is sealed once
   * and sent through APNs. Identical ciphertext for identical text would leak
   * "the same notification again" to anyone watching the transport. */
  const kS = await deriveSessionKey(await importEngineKey(randomBytes(32)), "s");
  const a = await sealPush(kS, { title: "t", body: "b", count: 1 });
  const b = await sealPush(kS, { title: "t", body: "b", count: 1 });
  expect(a).not.toBe(b);
  expect(await openPush(kS, b)).toEqual({ title: "t", body: "b", count: 1 });
});

test("the v1 handshake tag binds the label and both nonces", async () => {
  /* deriveAuthKey/handshakeTag are the pre-ECDH (task 527) shared-secret
   * handshake. They still ship in the byte-identical shared file, so they are
   * pinned here rather than left to rot untested. */
  const kAuth = await deriveAuthKey(await importEngineKey(randomBytes(32)));
  const tag = await handshakeTag(kAuth, "e", "CN", "EN");
  expect(await verifyHandshakeTag(kAuth, "e", "CN", "EN", tag)).toBe(true);
  expect(await verifyHandshakeTag(kAuth, "c", "CN", "EN", tag)).toBe(false);
  expect(await verifyHandshakeTag(kAuth, "e", "CN2", "EN", tag)).toBe(false);
  expect(await verifyHandshakeTag(kAuth, "e", "CN", "EN2", tag)).toBe(false);
});

/* --- blobs at rest -------------------------------------------------------- */

test("a blob with a bad magic or a truncated header is refused, never half-read", async () => {
  /* blobGen reads the generation out of the header before the key is chosen. A
   * short or foreign file reaching it (a half-written temp file, a plaintext
   * left from before sealing) must throw, not return an arbitrary generation
   * number and send the caller looking for a key that does not exist. */
  const kBlob = await deriveBlobKey(await importEngineKey(randomBytes(32)));
  const good = await sealBlob(kBlob, 4, te.encode("x"));
  expect(blobGen(good)).toBe(4);

  expect(() => blobGen(good.subarray(0, 19))).toThrow(/bad magic/);
  expect(() => blobGen(new Uint8Array(0))).toThrow(/bad magic/);
  const foreign = new Uint8Array(good);
  foreign[0] = 0x58; // "X" instead of "C"
  expect(() => blobGen(foreign)).toThrow(/bad magic/);
  await expect(openBlob(kBlob, foreign)).rejects.toThrow(/bad magic/);
  await expect(openBlob(kBlob, good.subarray(0, 19))).rejects.toThrow(/bad magic/);
});

test("a blob sealed under one content key does not open under another", async () => {
  const kA = await deriveBlobKey(await importEngineKey(randomBytes(32)));
  const kB = await deriveBlobKey(await importEngineKey(randomBytes(32)));
  const blob = await sealBlob(kA, 1, te.encode("a note at rest"));
  await expect(openBlob(kB, blob)).rejects.toThrow();
  // and the generation still reads: a device knows WHICH key it is missing
  expect(blobGen(blob)).toBe(1);
});

test("sealBlob carries an empty payload and a large generation number intact", async () => {
  const kBlob = await deriveBlobKey(await importEngineKey(randomBytes(32)));
  const empty = await sealBlob(kBlob, 0, new Uint8Array(0));
  expect(blobGen(empty)).toBe(0);
  expect(new Uint8Array(await openBlob(kBlob, empty)).length).toBe(0);
  // gen is a u32be: the top of the range must survive the round trip
  const big = await sealBlob(kBlob, 0xffffffff, te.encode("y"));
  expect(blobGen(big)).toBe(0xffffffff);
});
