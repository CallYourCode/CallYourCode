/* sec.ts v3 key model: the data dir's keys.json, its round-trip, the backup of
 * anything that is not v3, device enrolment (#579) and the HTTP owner
 * capability. The sealed handshake driven frame by frame lives in
 * secwire.test.ts; the crypto primitives underneath live in secvectors.test.ts.
 *
 * Everything here is pure unit: a keys.json under a per-test tmp dir and an
 * EngineSecConn fed strings by hand. No engine, no socket, no transport. */

import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpDataDir } from "../test-utils/tmp.ts";
import {
  loadOrCreateE2E,
  saveE2E,
  mintEngineId,
  enrolDevice,
  findDevice,
  newestGen,
  contentForWire,
  devicesForWire,
  EngineSecConn,
  verifyPairProof,
  verifyRelayAuth,
  relayAuthMessage,
  type ContentGen,
  type E2EState,
} from "./sec";
import {
  newIdentity,
  fpDisplay,
  keyId,
  randomBytes,
  importEngineKey,
  SecureChannel,
  signId,
  secTranscript,
  b64encode,
  derivePairKey,
  secPairTag,
} from "../../../shared/e2e";

/** A fresh data dir with nothing in it, and the keys.json path inside it. */
async function scratch(name = "keys.json"): Promise<string> {
  const { data } = await tmpDataDir("sec-");
  return join(data, name);
}

/** A second content generation, the shape a rotation would add. */
async function makeGen(gen: number): Promise<ContentGen> {
  const keyBytes = randomBytes(32);
  return {
    gen,
    kid: await keyId(keyBytes),
    keyBytes,
    key: await importEngineKey(keyBytes),
    createdAt: Date.now(),
    retiredAt: null,
  };
}

/* --- minting, reloading, and refusing to trust a foreign file ------------- */

test("fresh boot mints an engine id, an identity + one content generation, written 0600", async () => {
  const fp = await scratch();
  const st = await loadOrCreateE2E(fp);
  expect(st.engineId).toMatch(/^e-[0-9a-f]{32}$/);
  expect(st.identity.fp.length).toBe(43);
  expect(st.content.length).toBe(1);
  expect(st.content[0].gen).toBe(1);
  expect(st.content[0].keyBytes.length).toBe(32);
  expect(st.devices).toEqual([]);
  expect(st.migrated).toBe(false);
  expect(existsSync(fp)).toBe(true);
  // 0600
  expect(statSync(fp).mode & 0o777).toBe(0o600);
  // the file is valid v3 JSON with the identity fp and the engine id
  const j = JSON.parse(readFileSync(fp, "utf8"));
  expect(j.v).toBe(3);
  expect(j.engineId).toBe(st.engineId);
  expect(j.identity.fp).toBe(st.identity.fp);
  expect(j.content[0].kid).toBe(st.content[0].kid);
  // the kid on the wire is the kid OF that key, not a second invented value
  expect(j.content[0].kid).toBe(await keyId(st.content[0].keyBytes));
});

test("two fresh boots never share an engine id or an identity", async () => {
  /* engineId names the INSTALL. Two engines colliding on it would have the app
   * server overwrite one lease with the other's url and route a device to the
   * wrong machine. */
  const a = await loadOrCreateE2E(await scratch());
  const b = await loadOrCreateE2E(await scratch());
  expect(a.engineId).not.toBe(b.engineId);
  expect(a.identity.fp).not.toBe(b.identity.fp);
  expect(Array.from(a.content[0].keyBytes)).not.toEqual(Array.from(b.content[0].keyBytes));
  expect(mintEngineId()).toMatch(/^e-[0-9a-f]{32}$/);
  expect(mintEngineId()).not.toBe(mintEngineId());
});

test("reload returns the SAME identity, content and devices", async () => {
  const fp = await scratch();
  const a = await loadOrCreateE2E(fp);
  enrolDevice(a, "devfp1", "spki1", "iPhone");
  await saveE2E(a);

  const b = await loadOrCreateE2E(fp);
  expect(b.engineId).toBe(a.engineId);
  expect(b.identity.fp).toBe(a.identity.fp);
  expect(b.content[0].kid).toBe(a.content[0].kid);
  expect(Array.from(b.content[0].keyBytes)).toEqual(Array.from(a.content[0].keyBytes));
  expect(b.migrated).toBe(false);
  expect(findDevice(b, "devfp1")?.label).toBe("iPhone");
});

test("the reloaded identity still signs what the original signs: it is one key, not a lookalike", async () => {
  /* The identity survives a JWK export/import round trip. If the private half
   * came back subtly different, first contact would still work and every
   * RETURN visit would fail with "identity changed" on a device that pinned
   * the old fp: the exact bug that is invisible until a restart. */
  const fp = await scratch();
  const a = await loadOrCreateE2E(fp);
  const b = await loadOrCreateE2E(fp);
  const offer = await SecureChannel.offer();
  const { sec } = await SecureChannel.answer(offer.hello, b.identity, "example", "linux");
  // the device pinned a's fp at first contact and accepts b's handshake
  expect(await SecureChannel.accept(offer, sec, a.identity.fp)).toBeInstanceOf(SecureChannel);
  expect(b.identity.spki).toBe(a.identity.spki);
});

test("content generations, retirement and devices all survive a save/reload", async () => {
  const fp = await scratch();
  const a = await loadOrCreateE2E(fp);
  a.content.push(await makeGen(2));
  a.content[0].retiredAt = 1_700_000_000_000;
  const dev = enrolDevice(a, "devfp2", "spki2", "laptop");
  dev.revokedAt = 1_700_000_000_001;
  await saveE2E(a);

  const b = await loadOrCreateE2E(fp);
  expect(b.content.map((c) => c.gen)).toEqual([1, 2]);
  expect(b.content[0].retiredAt).toBe(1_700_000_000_000);
  expect(b.content[1].retiredAt).toBeNull();
  expect(Array.from(b.content[1].keyBytes)).toEqual(Array.from(a.content[1].keyBytes));
  // a revoked device stays on disk (revocation is a tombstone, not a delete)
  expect(b.devices.length).toBe(1);
  expect(b.devices[0].revokedAt).toBe(1_700_000_000_001);
  expect(devicesForWire(b)).toEqual([]);
});

test("saveE2E is atomic: it leaves no .tmp behind and the file stays 0600", async () => {
  /* .tmp + rename is the whole story of not losing the identity to a crash
   * mid-write. A leftover .tmp would be a world-readable copy of the content
   * keys sitting next to the 0600 file. */
  const fp = await scratch();
  const st = await loadOrCreateE2E(fp);
  await saveE2E(st);
  await saveE2E(st);
  const files = readdirSync(join(fp, ".."));
  expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  expect(files).toEqual(["keys.json"]);
  expect(statSync(fp).mode & 0o777).toBe(0o600);
});

test("a pre-v3 file (an old e2e shape) is renamed to keys.bak.json and a fresh v3 replaces it", async () => {
  const fp = await scratch();
  writeFileSync(fp, JSON.stringify({ v: 2, identity: { jwk: {} }, content: [] }) + "\n");
  const st = await loadOrCreateE2E(fp);
  expect(st.migrated).toBe(true);
  expect(st.identity.fp.length).toBe(43);
  expect(st.engineId).toMatch(/^e-[0-9a-f]{32}$/);
  expect(existsSync(fp.replace(/keys\.json$/, "keys.bak.json"))).toBe(true);
  expect(JSON.parse(readFileSync(fp, "utf8")).v).toBe(3);
});

test("a corrupt file is backed up, not trusted", async () => {
  const fp = await scratch();
  writeFileSync(fp, "{not json");
  const st = await loadOrCreateE2E(fp);
  expect(st.identity.fp.length).toBe(43);
  expect(existsSync(fp.replace(/keys\.json$/, "keys.bak.json"))).toBe(true);
});

test("the backup keeps the original bytes, and the replacement reloads clean", async () => {
  /* Backing up is only worth anything if the bytes are recoverable: this is the
   * file that holds an identity a phone has pinned. And the fresh file the
   * engine wrote in its place has to be a NORMAL v3 file, so the next boot does
   * not back that one up too and mint a third identity. */
  const fp = await scratch();
  const original = JSON.stringify({ v: 2, identity: { jwk: { kty: "EC" } } });
  writeFileSync(fp, original);
  const st = await loadOrCreateE2E(fp);
  const bak = fp.replace(/keys\.json$/, "keys.bak.json");
  expect(readFileSync(bak, "utf8")).toBe(original);

  const again = await loadOrCreateE2E(fp);
  expect(again.migrated).toBe(false);
  expect(again.identity.fp).toBe(st.identity.fp);
  expect(again.engineId).toBe(st.engineId);
});

test("a v3 file missing the engine id is foreign too: backed up, never half-loaded", async () => {
  /* v3 is the shape AND its required fields. A file that says v:3 but carries
   * no engineId is a hand-rolled or half-migrated file; loading it would give
   * the engine an undefined install id that then rides every announce. */
  for (const [name, body] of [
    ["no engineId", { v: 3, identity: { jwk: {} }, content: [] }],
    ["empty engineId", { v: 3, engineId: "", identity: { jwk: {} }, content: [] }],
    ["non-string engineId", { v: 3, engineId: 7, identity: { jwk: {} }, content: [] }],
    ["no identity", { v: 3, engineId: "e-1", content: [] }],
    ["v4 from the future", { v: 4, engineId: "e-1", identity: { jwk: {} } }],
  ] as const) {
    const fp = await scratch();
    writeFileSync(fp, JSON.stringify(body));
    const st = await loadOrCreateE2E(fp);
    expect(st.migrated, name).toBe(true);
    expect(st.engineId, name).toMatch(/^e-[0-9a-f]{32}$/);
    expect(existsSync(fp.replace(/keys\.json$/, "keys.bak.json")), name).toBe(true);
  }
});

test("a key file NOT named keys.json backs up beside itself as <path>.bak", async () => {
  /* The migration script and the tests both hand loadOrCreateE2E other paths
   * (.run/e2e.json). The backup must still land somewhere, or a corrupt file is
   * renamed onto a name that overwrites something. */
  const fp = await scratch("e2e.json");
  writeFileSync(fp, "not json at all");
  const st = await loadOrCreateE2E(fp);
  expect(st.migrated).toBe(true);
  expect(existsSync(`${fp}.bak`)).toBe(true);
});

test("a v3 file with sparse rows loads with defaults rather than undefined", async () => {
  /* Back-compat by absence (CONTRACT.md): a row written by an older engine has
   * no createdAt/lastSeenAt/revokedAt. Those must arrive as real values, since
   * `revokedAt: undefined` would not equal null and would refuse the device. */
  const fp = await scratch();
  const seed = await loadOrCreateE2E(fp);
  const j = JSON.parse(readFileSync(fp, "utf8"));
  j.content[0] = { gen: 1, kid: j.content[0].kid, key: j.content[0].key };
  j.devices = [{ fp: "devfp3", spki: "spki3" }];
  writeFileSync(fp, JSON.stringify(j));

  const st = await loadOrCreateE2E(fp);
  expect(st.migrated).toBe(false);
  expect(st.identity.fp).toBe(seed.identity.fp);
  expect(st.content[0].retiredAt).toBeNull();
  expect(typeof st.content[0].createdAt).toBe("number");
  const d = findDevice(st, "devfp3")!;
  expect(d.label).toBe("");
  expect(d.addedAt).toBe(0);
  expect(d.lastSeenAt).toBe(0);
  expect(d.revokedAt).toBeNull();
  expect(devicesForWire(st).map((x) => x.fp)).toEqual(["devfp3"]);
});

/* --- what goes on the wire ------------------------------------------------ */

test("wire shapes: content carries every gen, devices hide the revoked", async () => {
  const fp = await scratch();
  const st = await loadOrCreateE2E(fp);
  enrolDevice(st, "live", "spkiL", "laptop");
  const gone = enrolDevice(st, "dead", "spkiD", "old");
  gone.revokedAt = Date.now();

  expect(contentForWire(st)).toEqual([{ gen: 1, kid: st.content[0].kid, key: expect.any(String) }]);
  const wire = devicesForWire(st);
  expect(wire.map((d) => d.fp)).toEqual(["live"]);
  expect(newestGen(st).gen).toBe(1);
});

test("contentForWire carries RETIRED generations too, so a device can still read old blobs", async () => {
  /* Deliberate: retiring a generation stops the engine sealing NEW things under
   * it, it does not make everything already sealed unreadable. A device that
   * only received live generations would show empty chat history after a
   * rotation. */
  const st = await loadOrCreateE2E(await scratch());
  st.content.push(await makeGen(2));
  st.content[0].retiredAt = Date.now();
  expect(contentForWire(st).map((c) => c.gen)).toEqual([1, 2]);
  expect(newestGen(st).gen).toBe(2);
});

test("devicesForWire never leaks a device's public key or its revocation", async () => {
  /* The device list is shown in the app's settings screen. spki and revokedAt
   * are engine-side bookkeeping; sending them is not dangerous but it IS a
   * second shape of the same concept, and the app has never had a reader for
   * them. */
  const st = await loadOrCreateE2E(await scratch());
  const rec = enrolDevice(st, "fpA", "spkiA", "iPhone");
  expect(devicesForWire(st)).toEqual([
    { fp: "fpA", label: "iPhone", addedAt: rec.addedAt, lastSeenAt: rec.lastSeenAt },
  ]);
});

test("enrolDevice stamps the row and findDevice answers only for a known fp", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const before = Date.now();
  const rec = enrolDevice(st, "fpA", "spkiA", "laptop");
  expect(rec.revokedAt).toBeNull();
  expect(rec.addedAt).toBeGreaterThanOrEqual(before);
  expect(rec.lastSeenAt).toBe(rec.addedAt);
  expect(findDevice(st, "fpA")).toBe(rec);
  expect(findDevice(st, "fpB")).toBeUndefined();
  expect(findDevice(st, "")).toBeUndefined();
});

test("newestGen picks the newest LIVE generation, whatever order the array is in", async () => {
  const st = await loadOrCreateE2E(await scratch());
  st.content.push(await makeGen(3));
  st.content.push(await makeGen(2));
  expect(newestGen(st).gen).toBe(3);
  st.content[1].retiredAt = Date.now(); // retire gen 3
  expect(newestGen(st).gen).toBe(2);
  /* Everything retired: it falls back to the last row rather than returning
   * undefined and throwing somewhere far away inside a seal. */
  for (const c of st.content) c.retiredAt = Date.now();
  expect(newestGen(st).gen).toBe(2);
});

test("fpDisplay groups the first 16 hex of the fp hash", async () => {
  const id = await newIdentity(true);
  expect(fpDisplay(id.fp)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
});

/* --- the pairing proof ---------------------------------------------------- */

test("verifyPairProof accepts a live-generation proof and rejects absent/retired/bad", async () => {
  const fp = await scratch();
  const st = await loadOrCreateE2E(fp);
  const transcript = secTranscript("c", "ce", "ee", "cn", "en", st.identity.spki);

  const pairKey = await derivePairKey(newestGen(st).key);
  const good = await secPairTag(pairKey, transcript);

  expect(await verifyPairProof(st, good, transcript)).toBe(true);
  expect(await verifyPairProof(st, undefined, transcript)).toBe(false);
  expect(await verifyPairProof(st, "", transcript)).toBe(false);
  expect(await verifyPairProof(st, "not-a-tag", transcript)).toBe(false);

  // a retired generation no longer counts as a live proof
  const live = newestGen(st);
  live.retiredAt = Date.now();
  expect(await verifyPairProof(st, good, transcript)).toBe(false);
});

test("verifyPairProof accepts an OLDER live generation, and refuses another engine's key", async () => {
  /* Acceptance is "any live generation", not "the newest": a user who pasted
   * the key before a rotation still pairs until that generation is retired.
   * The refusal that matters is a proof made with a key this engine never had. */
  const st = await loadOrCreateE2E(await scratch());
  st.content.push(await makeGen(2)); // newest is gen 2; gen 1 stays live
  const transcript = secTranscript("c", "ce", "ee", "cn", "en", st.identity.spki);

  const oldProof = await secPairTag(await derivePairKey(st.content[0].key), transcript);
  expect(await verifyPairProof(st, oldProof, transcript)).toBe(true);

  const stranger = await loadOrCreateE2E(await scratch());
  const wrongEngine = await secPairTag(await derivePairKey(newestGen(stranger).key), transcript);
  expect(await verifyPairProof(st, wrongEngine, transcript)).toBe(false);

  // a proof lifted from a different handshake does not replay into this one
  const otherTranscript = secTranscript("c", "ce", "ee", "cn", "en2", st.identity.spki);
  const lifted = await secPairTag(await derivePairKey(newestGen(st).key), otherTranscript);
  expect(await verifyPairProof(st, lifted, transcript)).toBe(false);

  // no live generation at all: nothing pairs
  for (const c of st.content) c.retiredAt = Date.now();
  expect(await verifyPairProof(st, oldProof, transcript)).toBe(false);
});

test("an unknown device enrols only when sec-ok carries a valid pair proof", async () => {
  const fp = await scratch();
  const st = await loadOrCreateE2E(fp);
  const dev = await newIdentity(true);

  const te = new TextEncoder();
  /* THE RETURN SHAPE IS NAMED because `closed` is only ever written from inside
   * a callback, and TS's flow analysis does not follow that: without this it
   * infers `closed: null` and the assertions below read a property off `never`. */
  async function run(withPair: boolean): Promise<
    { opened: Record<string, any> | null; closed: { code: number; reason: string } | null }> {
    const engineOut: any[] = [];
    let closed: {code: number; reason: string} | null = null;
    const sec = new EngineSecConn(
      st, "example", "linux", "rtc",
      (f) => engineOut.push(f),
      () => {},
      () => {},
      (code, reason) => { closed = {code, reason}; },
    );
    const offer = await SecureChannel.offer();
    await sec.feed(JSON.stringify({ t: "hello", sec: offer.hello }));
    const secFrame = engineOut.find((f) => f.t === "sec");
    const chan = await SecureChannel.accept(offer, secFrame, null);
    const t = chan.transcript();
    const transcript = secTranscript("c", t.ce, t.ee, t.cn, t.en, t.id);
    const sig = b64encode(await signId(dev.keyPair.privateKey, te.encode(transcript)));
    const inner: any = { t: "sec-ok", dev: dev.spki, sig, label: "laptop" };
    if (withPair) {
      inner.pair = await secPairTag(await derivePairKey(newestGen(st).key), transcript);
    }
    await sec.feed(JSON.stringify(await chan.seal(inner)));
    const last = engineOut[engineOut.length - 1];
    const opened = last?.t === "x" ? await chan.open(last) : null;
    return { opened, closed };
  }

  // no pair: refused, nothing enrolled
  const noPair = await run(false);
  expect(noPair.opened).toEqual({ t: "sec-fail", reason: "unknown-device" });
  expect(noPair.closed?.reason).toBe("sec:unknown-device");
  expect(st.devices.length).toBe(0);

  // valid pair: enrolled and sec-done is sealed
  const withPair = await run(true);
  expect(withPair.opened, "a valid pair proof was answered with nothing at all").toBeTruthy();
  const done = withPair.opened!;
  expect(done.paired).toBe(true);
  expect(done.devices.length).toBe(1);
  expect(st.devices.length).toBe(1);
  // the enrolment reached DISK, not just memory: a restart keeps the device
  const reloaded = await loadOrCreateE2E(fp);
  expect(findDevice(reloaded, done.dev)?.label).toBe("laptop");
});

/* --- relay dial auth by device key --------------- */

test("relay dial auth: an enrolled device's signature is accepted; a wrong one rejected", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const dev = await newIdentity(true);
  enrolDevice(st, dev.fp, dev.spki, "phone");
  const nonce = "nonce-abc";
  const sig = b64encode(await signId(dev.keyPair.privateKey, relayAuthMessage(nonce, st.engineId)));

  // the enrolled device, correct nonce+engineId: accepted, ONE verify
  expect(await verifyRelayAuth(st, { nonce, spki: dev.spki, sig }))
    .toEqual({ ok: true, reason: "enrolled" });
  // the SAME signature under a different nonce is a bad signature
  expect((await verifyRelayAuth(st, { nonce: "other", spki: dev.spki, sig })).ok).toBe(false);
  // a malformed proof (nothing to verify)
  expect((await verifyRelayAuth(st, undefined)).reason).toBe("malformed");
  expect((await verifyRelayAuth(st, { nonce, spki: dev.spki })).reason).toBe("malformed");
});

test("relay dial auth: a revoked device is rejected even with a valid signature", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const dev = await newIdentity(true);
  const rec = enrolDevice(st, dev.fp, dev.spki, "old");
  rec.revokedAt = Date.now();
  const nonce = "n1";
  const sig = b64encode(await signId(dev.keyPair.privateKey, relayAuthMessage(nonce, st.engineId)));
  expect(await verifyRelayAuth(st, { nonce, spki: dev.spki, sig }))
    .toEqual({ ok: false, reason: "revoked" });
});

test("relay dial auth: a proof made for ANOTHER engine never verifies against this one", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const dev = await newIdentity(true);
  enrolDevice(st, dev.fp, dev.spki, "phone");
  const nonce = "n2";
  // signed with the WRONG engineId: unknown-key-share is exactly what binding
  // engineId into the message prevents.
  const sig = b64encode(await signId(dev.keyPair.privateKey, relayAuthMessage(nonce, "e-deadbeef")));
  expect((await verifyRelayAuth(st, { nonce, spki: dev.spki, sig })).reason).toBe("bad-sig");
});

test("relay dial auth: an unknown key rides the pairing lane, and the lane is rate-limited", async () => {
  const st = await loadOrCreateE2E(await scratch());
  const dev = await newIdentity(true); // never enrolled
  const nonce = "n3";
  const sig = b64encode(await signId(dev.keyPair.privateKey, relayAuthMessage(nonce, st.engineId)));

  // hammer the pairing lane with the same (valid, unenrolled) proof: it admits
  // some under the per-minute cap, then starts refusing with reason "pair-rate".
  // Order-independent: we only assert both outcomes occur, not the exact count
  // (the window is module-global and other tests may share the minute).
  const reasons = new Set<string>();
  for (let i = 0; i < 40; i++) {
    reasons.add((await verifyRelayAuth(st, { nonce, spki: dev.spki, sig })).reason);
  }
  expect(reasons.has("pairing")).toBe(true);
  expect(reasons.has("pair-rate")).toBe(true);
  // enrolment is still key-gated at the sec handshake, so this lane only decides
  // whether the stranger reaches that handshake, never whether it enrols.
  expect(findDevice(st, dev.fp)).toBeUndefined();
});
