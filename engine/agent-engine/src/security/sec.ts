/* Engine-side key model + sealed handshake (#579).
 *
 * The Node/Bun-specific half (the `keys.json` v3 file in the data dir, its
 * atomic write) lives here; the pure WebCrypto (identity, ECDH SecureChannel,
 * content-key derivations, sealing) is in e2e.ts, shared byte-for-value with the
 * app.
 *
 * v3 = the v2 e2e.json shape plus `engineId` (the stable per-install id that
 * used to live in `.run/engine-id`), under the keys.json name (the design). The
 * engine reads ONLY this shape; moving an old `.run` here is the standalone
 * migration script's job, never this module's.
 *
 * Enrolment (#key-required-enrol): an UNKNOWN device is key-gated on EVERY
 * transport. A device must prove it holds a live content generation's key
 * (sec-ok.pair, an HMAC over the handshake transcript) before the engine enrols
 * it; a known, unrevoked device needs no proof because it is already in the
 * device list. Transport no longer decides, so the direct DataChannel and the
 * hosted relay fold into the one proof below.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  b64decode,
  b64encode,
  exportSpki,
  fpOf,
  fpOfSpki,
  importEngineKey,
  importSpkiVerify,
  keyId,
  newIdentity,
  randomBytes,
  secTranscript,
  verifyId,
  SecureChannel,
  derivePairKey,
  verifySecPairTag,
  type EngineIdentity,
  type SealedFrame,
  type SecHello,
} from "../../../shared/e2e";

export type ContentGen = {
  gen: number;
  kid: string;
  keyBytes: Uint8Array; // the 32 raw bytes (also handed to a device in sec-done)
  key: CryptoKey; // HKDF form, for deriveBlobKey / deriveSessionKey
  createdAt: number;
  retiredAt: number | null;
};

export type DeviceRec = {
  fp: string;
  spki: string;
  label: string;
  addedAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

export type E2EState = {
  /** the stable per-install id (`e-` + 32 hex): names the install, not the url */
  engineId: string;
  identity: EngineIdentity;
  content: ContentGen[];
  devices: DeviceRec[];
  filePath: string;
  migrated: boolean; // an unreadable/foreign file was backed up on load (logged once)
};

// --- identity JWK <-> keypair ---

async function importIdentity(jwk: JsonWebKey): Promise<EngineIdentity> {
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pubJwk: JsonWebKey = { ...jwk, d: undefined, key_ops: ["verify"] };
  const pub = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  return { keyPair: { privateKey: priv, publicKey: pub } as CryptoKeyPair, spki: await exportSpki(pub), fp: await fpOf(pub) };
}

async function exportIdentityJwk(id: EngineIdentity): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", id.keyPair.privateKey);
}

async function makeContentGen(gen: number, createdAt: number): Promise<ContentGen> {
  const keyBytes = randomBytes(32);
  return { gen, kid: await keyId(keyBytes), keyBytes, key: await importEngineKey(keyBytes), createdAt, retiredAt: null };
}

/* Load `keys.json` v3, or create it on first boot (engine id, identity ECDSA
 * P-256, one content generation, empty device list). Anything that is not a v3
 * file is renamed `keys.bak.json` and a fresh file replaces it: an unreadable
 * key file must never be trusted, and the engine carries no migration code --
 * an old `.run/e2e.json` reaches this shape only through the standalone
 * migration script. ALWAYS runs -- there is no mode. */
export async function loadOrCreateE2E(filePath: string): Promise<E2EState> {
  if (existsSync(filePath)) {
    let j: any = null;
    try {
      j = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      j = null;
    }
    if (j && j.v === 3 && j.identity?.jwk && typeof j.engineId === "string" && j.engineId) {
      const identity = await importIdentity(j.identity.jwk);
      const content: ContentGen[] = [];
      for (const c of j.content ?? []) {
        const keyBytes = b64decode(c.key);
        content.push({
          gen: c.gen,
          kid: c.kid,
          keyBytes,
          key: await importEngineKey(keyBytes),
          createdAt: c.createdAt ?? Date.now(),
          retiredAt: c.retiredAt ?? null,
        });
      }
      const devices: DeviceRec[] = (j.devices ?? []).map((d: any) => ({
        fp: d.fp,
        spki: d.spki,
        label: d.label ?? "",
        addedAt: d.addedAt ?? 0,
        lastSeenAt: d.lastSeenAt ?? 0,
        revokedAt: d.revokedAt ?? null,
      }));
      try {
        chmodSync(filePath, 0o600);
      } catch {}
      return { engineId: j.engineId, identity, content, devices, filePath, migrated: false };
    }
    // not a v3 keys file (corrupt, foreign, or hand-rolled): back it up and regenerate.
    const bak = filePath.endsWith("keys.json")
      ? filePath.replace(/keys\.json$/, "keys.bak.json")
      : `${filePath}.bak`;
    renameSync(filePath, bak);
    const st = await freshState(filePath);
    st.migrated = true;
    await saveE2E(st);
    return st;
  }
  const st = await freshState(filePath);
  await saveE2E(st);
  return st;
}

/** A fresh install id: `e-` + 32 hex, the shape `.run/engine-id` always held. */
export function mintEngineId(): string {
  return `e-${crypto.randomUUID().replace(/-/g, "")}`;
}

async function freshState(filePath: string): Promise<E2EState> {
  const now = Date.now();
  const identity = await newIdentity(true);
  return { engineId: mintEngineId(), identity, content: [await makeContentGen(1, now)],
    devices: [], filePath, migrated: false };
}

/* Atomic write: `.tmp` + rename, 0600. One saveE2E after every
 * mutation (enrol, revoke, rotate, lastSeen). */
export async function saveE2E(st: E2EState): Promise<void> {
  const j = {
    v: 3,
    engineId: st.engineId,
    identity: {
      alg: "ES256",
      jwk: await exportIdentityJwk(st.identity),
      fp: st.identity.fp,
      createdAt: Date.now(),
    },
    content: st.content.map((c) => ({
      gen: c.gen,
      kid: c.kid,
      key: b64encode(c.keyBytes),
      createdAt: c.createdAt,
      retiredAt: c.retiredAt,
    })),
    devices: st.devices,
  };
  mkdirSync(dirname(st.filePath), { recursive: true });
  const tmp = st.filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(j) + "\n", { mode: 0o600 });
  renameSync(tmp, st.filePath);
  try {
    chmodSync(st.filePath, 0o600);
  } catch {}
}

/* The newest live (non-retired) generation: everything NEW is sealed under it. */
export function newestGen(st: E2EState): ContentGen {
  const live = st.content.filter((c) => c.retiredAt === null).sort((a, b) => b.gen - a.gen);
  return live[0] ?? st.content[st.content.length - 1];
}

/* Every live generation a device receives at connect (sec-done): {gen, kid, key}. */
export function contentForWire(st: E2EState): { gen: number; kid: string; key: string }[] {
  return st.content.map((c) => ({ gen: c.gen, kid: c.kid, key: b64encode(c.keyBytes) }));
}

export function findDevice(st: E2EState, fp: string): DeviceRec | undefined {
  return st.devices.find((d) => d.fp === fp);
}

/* Enrol a first-contact device (auto path). label comes from the app's UA. */
export function enrolDevice(st: E2EState, fp: string, spki: string, label: string): DeviceRec {
  const now = Date.now();
  const rec: DeviceRec = { fp, spki, label, addedAt: now, lastSeenAt: now, revokedAt: null };
  st.devices.push(rec);
  return rec;
}

export function devicesForWire(st: E2EState): { fp: string; label: string; addedAt: number; lastSeenAt: number }[] {
  return st.devices
    .filter((d) => d.revokedAt === null)
    .map((d) => ({ fp: d.fp, label: d.label, addedAt: d.addedAt, lastSeenAt: d.lastSeenAt }));
}

/* Verify the sec-ok.pair proof against every LIVE content generation. True when
 * any live generation's pairKey reproduces the tag for this transcript. */
export async function verifyPairProof(
  state: E2EState,
  pair: string | undefined,
  transcript: string,
): Promise<boolean> {
  if (typeof pair !== "string" || !pair) return false;
  for (const c of state.content) {
    if (c.retiredAt !== null) continue;
    const pairKey = await derivePairKey(c.key);
    if (await verifySecPairTag(pairKey, transcript, pair)) return true;
  }
  return false;
}

/* The engine's fp in its display form is e2e.ts fpDisplay(fp); re-exported so
 * server.ts and pair.ts have one import for the identity surface. */
export { fpDisplay } from "../../../shared/e2e";

const enc = new TextEncoder();

/* ---- relay dial auth by DEVICE KEY ---------------
 *
 * The relay is blind: it challenges a device with a nonce and forwards the
 * device's signed proof to this engine inside r-open. THIS is where the proof
 * is verified, against the one trust root that governs the seal too: the
 * enrolled, unrevoked device list. No Clerk token, no bearer in any URL.
 *
 * The device signs the bytes `nonce | engineId | "cyc-relay-auth-v1"` with the
 * SAME device identity key the sec handshake pins; the app builds the identical
 * message (app/src/engine/client.ts relayAuthFor). Rebuilt here from THIS
 * engine's own engineId, so a proof made for another engine never verifies. */
export const RELAY_AUTH_CONTEXT = "cyc-relay-auth-v1";

/** The exact bytes signed/verified for a relay dial. Kept byte-identical to
 *  what the app's relayAuthFor signs (it inlines this same string); the nonce
 *  and engineId are unambiguous (base64url and `e-`+hex, neither contains `|`). */
export function relayAuthMessage(nonce: string, engineId: string): Uint8Array {
  return enc.encode(`${nonce}|${engineId}|${RELAY_AUTH_CONTEXT}`);
}

/* The pairing lane: an UNKNOWN device key may still dial under a
 * tight per-minute cap, because enrolment itself is key-gated by sec-ok.pair, so
 * an unproven device dies at the sec handshake anyway. This bounds how fast a
 * stranger can even reach that handshake. Enrolled devices are never counted. */
export const RELAY_PAIR_OPENS_PER_MIN = 10;
const PAIR_WINDOW_MS = 60_000;
let pairWindow = { start: 0, count: 0 };

/** True while the pairing lane still has budget this minute (and consumes one).
 *  Exported so a test can reason about the cap; production only calls it via
 *  verifyRelayAuth. */
export function pairLaneAdmits(now = Date.now()): boolean {
  if (now - pairWindow.start >= PAIR_WINDOW_MS) pairWindow = { start: now, count: 0 };
  return ++pairWindow.count <= RELAY_PAIR_OPENS_PER_MIN;
}

export type RelayAuthProof = { nonce?: unknown; spki?: unknown; sig?: unknown };
export type RelayAuthVerdict = { ok: boolean; reason: string };

/* Verify one relay dial's device-key proof. ONE signature verify per dial:
 *   - malformed / bad key / bad signature  -> reject
 *   - a signature by an ENROLLED, unrevoked device -> accept
 *   - a revoked device -> reject
 *   - an UNKNOWN but self-consistent key -> accept only while the pairing lane
 *     has budget (it still must pass the key-gated sec handshake to enrol). */
export async function verifyRelayAuth(
  state: E2EState,
  auth: RelayAuthProof | undefined,
): Promise<RelayAuthVerdict> {
  if (!auth || typeof auth.nonce !== "string" || typeof auth.spki !== "string" ||
      typeof auth.sig !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const pub = await importSpkiVerify(auth.spki).catch(() => null);
  if (!pub) return { ok: false, reason: "bad-key" };
  const sigOk = await verifyId(
    pub, relayAuthMessage(auth.nonce, state.engineId), b64decode(auth.sig),
  ).catch(() => false);
  if (!sigOk) return { ok: false, reason: "bad-sig" };
  const fp = await fpOfSpki(auth.spki);
  const dev = findDevice(state, fp);
  if (dev) {
    if (dev.revokedAt !== null) return { ok: false, reason: "revoked" };
    return { ok: true, reason: "enrolled" };
  }
  if (!pairLaneAdmits()) return { ok: false, reason: "pair-rate" };
  return { ok: true, reason: "pairing" };
}

/* The HTTP owner capability is DELETED (sealed-transport enforcement):
 * requireOwner answers only true loopback and the sealed tunnel mark, so no
 * derived bearer exists at all. deriveHttpCap/httpCapFor/verifyHttpCap and the
 * sec-done `cap` field all went with it. */

/* The engine's per-connection sec state machine. Feed it every
 * plaintext string the pipe delivers; it answers the hello, verifies the
 * device's sec-ok, enrols or refuses, sends sec-done, then hands each OPENED
 * inner frame up to onFrame -- so the dispatcher above never knows the pipe is
 * sealed, exactly as the pre-579 plaintext socket looked. One per RtcSock. */
export class EngineSecConn {
  private chan: SecureChannel | null = null;
  ready = false;
  devFp: string | null = null;
  private done = false;
  // Serialises sealed writes so the GCM counter order == the order bytes hit the
  // pipe; a burst sealed concurrently would otherwise reach the receiver out of
  // n-order and be refused as a replay.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private state: E2EState,
    private user: string,
    private host: string,
    /* Positional, deliberately NOT a field: every caller states the transport
     * it is opening on, but nothing in here reads it back. Kept in the
     * signature so the call sites stay honest about which pipe they are. */
    _transport: "ws" | "rtc" | "relay",
    /** plaintext write on the pipe (the caller JSON.stringifies + pipe.send). */
    private send: (frame: unknown) => void,
    /** the device is enrolled and sec-done sent: send the sealed hello burst. */
    private onReady: () => void,
    /** an opened client frame, for the normal dispatcher. */
    private onFrame: (inner: any) => void,
    /** tear the socket down with a close code. */
    private onClose: (code: number, reason: string) => void,
  ) {}

  /** Seal + send an inner frame (only valid once the channel exists), chained so
   * counter order matches wire order. */
  sealSend(inner: unknown): Promise<void> {
    const chan = this.chan;
    if (!chan) return Promise.resolve();
    this.writeChain = this.writeChain.then(async () => {
      try {
        this.send(await chan.seal(inner));
      } catch {
        // socket gone; the close handler cleans up
      }
    });
    return this.writeChain;
  }

  private async fail(reason: string, code = 4403): Promise<void> {
    console.log(`[sec] fail code=${code} reason=${reason}`);
    if (this.chan) {
      try {
        await this.sealSend({ t: "sec-fail", reason });
      } catch {}
    }
    this.onClose(code, "sec:" + reason);
  }

  async feed(raw: string): Promise<void> {
    if (this.done) return;
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    /* JSON.parse SUCCEEDS ON "null", AND ON "7", AND ON '"hi"'. The catch above
     * only covers bytes that are not JSON at all, so a client writing the four
     * characters `null` got past it and the next line read `m.t` off null:
     * "TypeError: null is not an object". rtc-glue calls this as
     * `void sec.feed(raw)`, so that TypeError is an UNHANDLED REJECTION, thrown
     * by any peer that can open a DataChannel, before it has proved anything.
     * A non-object frame is not a frame; it is dropped like any other junk. */
    if (!m || typeof m !== "object") return;

    // --- before the channel: the plaintext hello ---
    if (!this.chan) {
      if (m.t === "hello" && m.sec && typeof m.sec.ce === "string") {
        const { sec, chan } = await SecureChannel.answer(m.sec as SecHello, this.state.identity, this.user, this.host);
        this.chan = chan;
        // the sec frame rides the wire as {t:"sec", ...}.
        this.send({ t: "sec", ...sec });
        return;
      }
      if (m.t === "hello") {
        // a bare hello (a hand-rolled client): fp + user/host, nothing else,
        // no session list. It reconnects with `sec` to enrol.
        this.send({ t: "sec-required", v: 2, fp: this.state.identity.fp, user: this.user, host: this.host });
        return;
      }
      return; // undeclared frame before hello
    }

    // --- after the channel: every frame is a sealed {t:"x",n,ct} ---
    if (m.t !== "x") {
      console.log("[sec] fail code=4400 reason=plaintext-after-sec");
      this.onClose(4400, "sec:plaintext-after-sec");
      return;
    }
    let inner: any;
    try {
      inner = await this.chan.open(m as SealedFrame);
    } catch {
      console.log("[sec] fail code=4401 reason=bad-frame");
      this.onClose(4401, "sec:bad-frame");
      return;
    }

    if (!this.ready) {
      if (inner?.t !== "sec-ok" || typeof inner.dev !== "string" || typeof inner.sig !== "string") {
        console.log("[sec] fail code=4400 reason=want-sec-ok");
        this.onClose(4400, "sec:want-sec-ok");
        return;
      }
      const t = this.chan.transcript();
      const devPub = await importSpkiVerify(inner.dev).catch(() => null);
      if (!devPub) {
        console.log("[sec] fail code=4401 reason=bad-dev-key");
        this.onClose(4401, "sec:bad-dev-key");
        return;
      }
      const ok = await verifyId(
        devPub,
        enc.encode(secTranscript("c", t.ce, t.ee, t.cn, t.en, t.id)),
        b64decode(inner.sig),
      );
      if (!ok) {
        await this.fail("bad-sig");
        return;
      }
      const devFp = await fpOfSpki(inner.dev);
      const existing = findDevice(this.state, devFp);
      let paired = false;
      if (existing) {
        if (existing.revokedAt !== null) {
          await this.fail("revoked");
          return;
        }
        existing.lastSeenAt = Date.now();
        await saveE2E(this.state);
      } else {
        /* Unknown device (#key-required-enrol): enrol ONLY when sec-ok carries
         * a valid pair proof against a live content generation. No proof, or a
         * bad one, is refused and the app shows the pairing screen. */
        const ok = await verifyPairProof(
          this.state,
          inner.pair,
          secTranscript("c", t.ce, t.ee, t.cn, t.en, t.id),
        );
        if (!ok) {
          await this.fail("unknown-device");
          return;
        }
        enrolDevice(this.state, devFp, inner.dev, String(inner.label ?? ""));
        paired = true;
        await saveE2E(this.state);
        console.log(`[sec] enrol ok devices=${this.state.devices.length}`);
      }
      this.devFp = devFp;
      this.ready = true;
      await this.sealSend({
        t: "sec-done",
        fp: this.state.identity.fp,
        dev: devFp,
        paired,
        content: contentForWire(this.state),
        devices: devicesForWire(this.state),
        /* No `cap` field any more: the HTTP bearer is deleted. The channel
         * itself is the owner credential (markSealedTunnel on tunnelled
         * requests); there is nothing to hand out. */
      });
      this.onReady();
      return;
    }

    // ready: hand the opened frame to the ordinary dispatcher.
    this.onFrame(inner);
  }

  markClosed(): void {
    this.done = true;
  }
}
