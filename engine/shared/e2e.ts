/* E2E crypto core (task 527). PURE WebCrypto, no Node and no Bun APIs, so this
 * exact file body runs unchanged in Bun, in the browser window, and inside the
 * service worker. This is the SINGLE shared module: both the
 * engine and the app bundle import it directly (the app via its @shared alias),
 * so there is no twin to keep in sync. The wire is the contract and is pinned
 * by fixtures/e2e-vectors.json, exercised from both bundles.
 *
 * The whole toolbox is HKDF-SHA256, AES-256-GCM and HMAC-SHA256, because those
 * three exist identically in Bun and every target browser. No argon2/scrypt:
 * key stretching protects LOW-entropy secrets, and the 12 words carry 128 bits
 * of real entropy, which cannot be brute-forced. A memory-hard KDF would buy
 * nothing and cost a WASM dependency the service worker cannot easily carry.
 *
 * The key-derivation table and the threat each choice accepts are documented
 * below alongside the derivation code and the pinned vectors.
 */


/* ArrayBuffer-backed byte view. WebCrypto's BufferSource narrows to an
 * ArrayBuffer-backed view under newer DOM libs (the app bundle's TS lib), which
 * reject a plain Uint8Array whose buffer widens to ArrayBufferLike. Every array
 * in this module is ArrayBuffer-backed at runtime, so we assert it at the crypto
 * boundary. Type-only; no copy, no behaviour change. The engine's own lib is
 * lenient, so this also compiles there. */
type Bin = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

// --- bytes <-> base64 / base64url (env-neutral: no Buffer, no atob binary quirks) ---

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const str = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((str.length * 6) / 8));
  let bits = 0;
  let val = 0;
  let o = 0;
  for (let i = 0; i < str.length; i++) {
    const idx = B64.indexOf(str[i]);
    if (idx < 0) continue;
    val = (val << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (val >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function b64urlencode(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urldecode(s: string): Uint8Array {
  return b64decode(s.replace(/-/g, "+").replace(/_/g, "/"));
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u64be(n: number): Uint8Array {
  // n is a JS safe integer (counters never approach 2^53). Big-endian 8 bytes.
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 7; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

// timing-safe-ish compare over equal-length byte arrays
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(bytes: Uint8Array): Promise<Bin> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Bin));
}

// --- key hierarchy (all HKDF-SHA256 from kEngine, domain-separated info) ---

/** Import 32 raw bytes of kEngine as a NON-EXTRACTABLE HKDF key. This is the
 * form stored in the app's IndexedDB: usable to derive every subkey, never
 * exportable, structured-cloneable into the DB. */
export async function importEngineKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes as Bin, "HKDF", false, ["deriveBits", "deriveKey"]);
}

const EMPTY = new Uint8Array(0);

async function subBits(
  kEngine: CryptoKey,
  info: Uint8Array,
  salt: Uint8Array,
  bytes: number,
): Promise<Bin> {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Bin, info: info as Bin },
    kEngine,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** kid = first 8 bytes of SHA-256(kEngine), base64url. Rides plaintext so a
 * multi-engine device picks the right stored key. */
export async function keyId(kEngineBytes: Uint8Array): Promise<string> {
  const h = await sha256(kEngineBytes);
  return b64urlencode(h.subarray(0, 8));
}

export async function deriveAuthKey(kEngine: CryptoKey): Promise<CryptoKey> {
  const raw = await subBits(kEngine, enc.encode("auth"), EMPTY, 32);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Per-connection frame keys. dir "c2e"/"e2c"; salt = clientNonce || engineNonce
 * so fresh nonces each connection make the keys per-connection: a frame captured
 * on one connection is garbage on the next. */
export async function deriveFrameKey(
  kEngine: CryptoKey,
  dir: "c2e" | "e2c",
  clientNonce: Uint8Array,
  engineNonce: Uint8Array,
): Promise<CryptoKey> {
  const raw = await subBits(kEngine, enc.encode(dir), concat(clientNonce, engineNonce), 32);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Per-session key: push payload encryption now, session sharing later. HKDF is
 * one-way, so kS never climbs back to kEngine; handing over one session means
 * handing over only its kS. */
export async function deriveSessionKey(kEngine: CryptoKey, sessionId: string): Promise<CryptoKey> {
  const raw = await subBits(kEngine, enc.encode("session:" + sessionId), EMPTY, 32);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Engine-level (session-LESS) push key: for a notification that is about the
 * ENGINE/account, not any one chat (a plan-usage threshold alert). Domain-
 * separated by the HKDF info "notify", which cannot collide with any
 * "session:<id>" (or "auth"/"blob"/"pair"/"c2e"/"e2c"), so an engine-sealed item
 * and a session-sealed one never open under each other's key. The device (its
 * service worker) derives the SAME key when a sealed item carries no sessionId. */
export async function deriveEngineNotifyKey(kEngine: CryptoKey): Promise<CryptoKey> {
  const raw = await subBits(kEngine, enc.encode("notify"), EMPTY, 32);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// --- handshake MACs (kAuth) ---

async function hmac(key: CryptoKey, msg: Uint8Array): Promise<Bin> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msg as Bin));
}

/** tag proving the ENGINE holds the key. label "e" for the engine's e2e frame,
 * "c" for the client's e2e-ok. cn/en are the base64 nonces exactly as sent. */
export async function handshakeTag(
  kAuth: CryptoKey,
  label: "e" | "c",
  cn: string,
  en: string,
): Promise<string> {
  return b64encode(await hmac(kAuth, enc.encode(label + "|" + cn + "|" + en)));
}

export async function verifyHandshakeTag(
  kAuth: CryptoKey,
  label: "e" | "c",
  cn: string,
  en: string,
  tag: string,
): Promise<boolean> {
  const want = await hmac(kAuth, enc.encode(label + "|" + cn + "|" + en));
  return constantTimeEqual(want, b64decode(tag));
}

// --- key-gated enrolment proof (#key-required-enrol) ---

/** Derive the HMAC key for sec-ok.pair. HKDF from the content key under info
 * "pair", so the device that pasted the key and the engine holding the same
 * generation derive the SAME key. */
export async function derivePairKey(contentKey: CryptoKey): Promise<CryptoKey> {
  const raw = await subBits(contentKey, enc.encode("pair"), EMPTY, 32);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** The proof: HMAC-SHA256 over SHA-256(handshake transcript), keyed by pairKey.
 * The transcript is the c-side string (cyc-sec-v2|c|ce|ee|cn|en|id). */
export async function secPairTag(pairKey: CryptoKey, transcript: string): Promise<string> {
  const h = await sha256(enc.encode(transcript));
  return b64encode(await hmac(pairKey, h));
}

export async function verifySecPairTag(
  pairKey: CryptoKey,
  transcript: string,
  tag: string,
): Promise<boolean> {
  const want = await secPairTag(pairKey, transcript);
  return constantTimeEqual(b64decode(want), b64decode(tag));
}

// --- frame envelope (counter-IV AES-256-GCM) ---

export type SealedFrame = { t: "x"; n: number; ct: string };

function frameIv(dir: "c2e" | "e2c", n: number): Uint8Array {
  // IV is never sent: dir(4 ascii bytes) || n as u64be = 12 bytes. Deterministic
  // counter IVs under a per-connection key can never repeat; nothing random to
  // get wrong. dir keeps the two directions from ever sharing an (key,IV) pair.
  return concat(enc.encode(dir + ":"), u64be(n));
}

/** Encrypt one WHOLE inner frame. The receiver reconstructs the IV from dir+n. */
export async function sealFrame(
  key: CryptoKey,
  dir: "c2e" | "e2c",
  n: number,
  inner: unknown,
): Promise<SealedFrame> {
  const pt = enc.encode(JSON.stringify(inner));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: frameIv(dir, n) as Bin }, key, pt as Bin),
  );
  return { t: "x", n, ct: b64encode(ct) };
}

/** Decrypt and JSON-parse. Throws on a bad tag (forgery). Replay (n not strictly
 * increasing) is the caller's job against its per-direction counter; see
 * FrameReceiver. */
export async function openFrame(
  key: CryptoKey,
  dir: "c2e" | "e2c",
  frame: SealedFrame,
): Promise<any> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: frameIv(dir, frame.n) as Bin },
    key,
    b64decode(frame.ct) as Bin,
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Per-direction receive counter. Requires strictly increasing n; anything else
 * is a replay or reorder and is refused. GCM's tag is the forgery protection;
 * this is the in-connection replay protection.
 *
 * Opens are SERIALISED through a chain: decryption is async, so two frames
 * arriving back to back would otherwise both read `next`, both pass the check,
 * and both advance it (a replay slipping through, caught by relay-proof.test).
 * Chaining makes the check-and-advance atomic per frame while preserving order,
 * because open() is invoked synchronously in arrival order. */
export class FrameReceiver {
  private next = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private key: CryptoKey,
    private dir: "c2e" | "e2c",
  ) {}
  /** Returns the inner frame, or throws Error("e2e.replay") / a GCM error. */
  open(frame: SealedFrame): Promise<any> {
    const run = this.chain.then(() => this.openOne(frame));
    // one bad frame must not poison the chain for the next one
    this.chain = run.catch(() => {});
    return run;
  }
  private async openOne(frame: SealedFrame): Promise<any> {
    if (typeof frame.n !== "number" || !Number.isInteger(frame.n) || frame.n < this.next) {
      throw new Error("e2e.replay");
    }
    const inner = await openFrame(this.key, this.dir, frame);
    // Only advance after the tag verifies, so a forged high-n frame cannot
    // burn counter space and wedge the real stream.
    this.next = frame.n + 1;
    return inner;
  }
}

/** Per-direction send counter. */
export class FrameSender {
  private n = 0;
  constructor(
    private key: CryptoKey,
    private dir: "c2e" | "e2c",
  ) {}
  async seal(inner: unknown): Promise<SealedFrame> {
    return sealFrame(this.key, this.dir, this.n++, inner);
  }
}

// --- push blob (kS, random IV: volume is tiny, keys long-lived) ---

export async function sealPush(kS: CryptoKey, payload: unknown): Promise<string> {
  const iv = randomBytes(12);
  const pt = enc.encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as Bin }, kS, pt as Bin));
  return b64encode(concat(iv, ct));
}

export async function openPush(kS: CryptoKey, blob: string): Promise<any> {
  const raw = b64decode(blob);
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as Bin }, kS, ct as Bin);
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ===== v2 (#579): identity, the ECDH SecureChannel, content keys, blobs =====
 *
 * Added ahead of its callers; nothing calls it yet (the server and client
 * wire it in later). One shared module imported by both bundles, pinned by
 * fixtures/e2e-vectors.json. */

// --- identity (ECDSA P-256): engine + device ---

export type EngineIdentity = { keyPair: CryptoKeyPair; spki: string; fp: string };

/** ECDSA P-256 keypair. The engine's is extractable (persisted as JWK); the
 * device's is non-extractable (lives in IndexedDB, never leaves the browser). */
export async function generateIdentity(extractable: boolean): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, extractable, [
    "sign",
    "verify",
  ]);
}

async function rawPoint(pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", pub)); // 65 B uncompressed
}

export async function exportSpki(pub: CryptoKey): Promise<string> {
  return b64encode(new Uint8Array(await crypto.subtle.exportKey("spki", pub)));
}

export async function importSpkiVerify(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", b64decode(spki) as Bin, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
}

/** fp = base64url(SHA-256(raw uncompressed public point, 65 B)), 43 chars. This
 * string IS the identity everywhere: the app's IndexedDB key, the pinned id. */
export async function fpOf(pub: CryptoKey): Promise<string> {
  return b64urlencode(await sha256(await rawPoint(pub)));
}
export async function fpOfSpki(spki: string): Promise<string> {
  return fpOf(await importSpkiVerify(spki));
}

/** Display form: the first 16 hex chars of the same SHA-256, grouped
 * `xxxx xxxx xxxx xxxx`. One derivation (fp), two renderings. */
export function fpDisplay(fp: string): string {
  const h = b64urldecode(fp).subarray(0, 8);
  const hex = Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.replace(/(.{4})(?=.)/g, "$1 ");
}

export async function signId(priv: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, data as Bin));
}
export async function verifyId(pub: CryptoKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  // NB WebCrypto order is verify(alg, key, SIGNATURE, DATA).
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig as Bin, data as Bin);
}

export async function newIdentity(extractable = true): Promise<EngineIdentity> {
  const keyPair = await generateIdentity(extractable);
  return { keyPair, spki: await exportSpki(keyPair.publicKey), fp: await fpOf(keyPair.publicKey) };
}

// --- per-connection ECDH key agreement ---

async function ecdhKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}
export async function importEcdhPoint(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Bin, { name: "ECDH", namedCurve: "P-256" }, false, []);
}
/** ss = ECDH(own ephemeral private, peer ephemeral public) -> HKDF kRoot. */
export async function ecdhRoot(priv: CryptoKey, peerPub: CryptoKey): Promise<CryptoKey> {
  const ss = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, priv, 256));
  return crypto.subtle.importKey("raw", ss, "HKDF", false, ["deriveBits"]);
}

// --- SecureChannel: the transport-agnostic sealed channel ---

export type SecHello = { v: 2; ce: string; cn: string };
export type SecFrame = { v: 2; ee: string; en: string; id: string; sig: string; user: string; host: string };
export type SecOffer = { hello: SecHello; ephemeral: CryptoKeyPair; cn: Uint8Array };

/** The signed transcript. Engine side (`e`) binds ce|ee|cn|en AND the
 * user/host labels it announces (M3, security hardening: they used to ride
 * unsigned beside the sig, so an in-path attacker relaying an otherwise valid
 * handshake could relabel the engine); device side (`c`) additionally binds
 * the engine's `id` so its auth is specific to this engine (no
 * unknown-key-share). Strings exactly as they ride the wire. */
export function secTranscript(
  side: "e" | "c",
  ce: string,
  ee: string,
  cn: string,
  en: string,
  id?: string,
  user?: string,
  host?: string,
): string {
  const base = "cyc-sec-v2|" + side + "|" + ce + "|" + ee + "|" + cn + "|" + en;
  return side === "c" ? base + "|" + id : base + "|" + (user ?? "") + "|" + (host ?? "");
}

export class SecureChannel {
  private constructor(
    private sender: FrameSender,
    private receiver: FrameReceiver,
    private t: { ce: string; ee: string; cn: string; en: string; id: string },
  ) {}

  /** device side, step 1: ephemeral + client nonce; nothing secret leaves. */
  static async offer(): Promise<SecOffer> {
    const ephemeral = await ecdhKeypair();
    const cn = randomBytes(16);
    const ce = b64encode(await rawPoint(ephemeral.publicKey));
    return { hello: { v: 2, ce, cn: b64encode(cn) }, ephemeral, cn };
  }

  /** engine side: ephemeral + engine nonce, sign the transcript with identity. */
  static async answer(
    hello: SecHello,
    identity: EngineIdentity,
    user: string,
    host: string,
  ): Promise<{ sec: SecFrame; chan: SecureChannel }> {
    const ephemeral = await ecdhKeypair();
    const en = randomBytes(16);
    const ee = b64encode(await rawPoint(ephemeral.publicKey));
    const enB = b64encode(en);
    const kRoot = await ecdhRoot(ephemeral.privateKey, await importEcdhPoint(b64decode(hello.ce)));
    const cn = b64decode(hello.cn);
    const sender = new FrameSender(await deriveFrameKey(kRoot, "e2c", cn, en), "e2c");
    const receiver = new FrameReceiver(await deriveFrameKey(kRoot, "c2e", cn, en), "c2e");
    const sig = b64encode(
      await signId(identity.keyPair.privateKey,
        enc.encode(secTranscript("e", hello.ce, ee, hello.cn, enB, undefined, user, host))),
    );
    const sec: SecFrame = { v: 2, ee, en: enB, id: identity.spki, sig, user, host };
    return {
      sec,
      chan: new SecureChannel(sender, receiver, { ce: hello.ce, ee, cn: hello.cn, en: enB, id: identity.spki }),
    };
  }

  /** device side, step 2: verify the engine sig (+ the pinned fp on a return
   * visit), then derive the channel. Throws on a changed identity or bad sig. */
  static async accept(offer: SecOffer, sec: SecFrame, expectFp: string | null): Promise<SecureChannel> {
    if (expectFp && (await fpOfSpki(sec.id)) !== expectFp) throw new Error("sec: engine identity changed");
    const idKey = await importSpkiVerify(sec.id);
    const ok = await verifyId(
      idKey,
      enc.encode(secTranscript("e", offer.hello.ce, sec.ee, offer.hello.cn, sec.en,
        undefined, sec.user, sec.host)),
      b64decode(sec.sig),
    );
    if (!ok) throw new Error("sec: bad engine sig");
    const kRoot = await ecdhRoot(offer.ephemeral.privateKey, await importEcdhPoint(b64decode(sec.ee)));
    const cn = offer.cn;
    const en = b64decode(sec.en);
    const sender = new FrameSender(await deriveFrameKey(kRoot, "c2e", cn, en), "c2e");
    const receiver = new FrameReceiver(await deriveFrameKey(kRoot, "e2c", cn, en), "e2c");
    return new SecureChannel(sender, receiver, { ce: offer.hello.ce, ee: sec.ee, cn: offer.hello.cn, en: sec.en, id: sec.id });
  }

  seal(inner: unknown): Promise<SealedFrame> {
    return this.sender.seal(inner);
  }
  open(frame: SealedFrame): Promise<any> {
    return this.receiver.open(frame);
  }
  /** ce, ee, cn, en, id exactly as they went on the wire (for sec-ok's sig). */
  transcript(): { ce: string; ee: string; cn: string; en: string; id: string } {
    return { ...this.t };
  }
}

// --- content keys + sealed blobs at rest ---

/** A content key is 32 raw bytes imported as HKDF: importEngineKey(bytes). */

/** kBlob = HKDF(content[gen], info "blob"). */
export async function deriveBlobKey(contentKey: CryptoKey): Promise<CryptoKey> {
  const raw = await subBits(contentKey, enc.encode("blob"), new Uint8Array(0), 32);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const BLOB_MAGIC = enc.encode("CYB2"); // 4 ascii

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

/** Layout: "CYB2" | gen u32be | iv 12B (random) | AES-256-GCM ct (incl 16B tag).
 * Random IV is safe here: tiny volume, long-lived key (527's push argument). */
export async function sealBlob(kBlob: CryptoKey, gen: number, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as Bin }, kBlob, bytes as Bin));
  return concat(BLOB_MAGIC, u32be(gen), iv, ct);
}

/** The generation a blob was sealed under, so the caller derives the right
 * kBlob before openBlob. Throws on a bad magic or a truncated header. */
export function blobGen(blob: Uint8Array): number {
  if (blob.length < 20 || !eqBytes(blob.subarray(0, 4), BLOB_MAGIC)) throw new Error("blob: bad magic");
  return new DataView(blob.buffer, blob.byteOffset + 4, 4).getUint32(0, false);
}

export async function openBlob(kBlob: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 20 || !eqBytes(blob.subarray(0, 4), BLOB_MAGIC)) throw new Error("blob: bad magic");
  const iv = blob.subarray(8, 20);
  const ct = blob.subarray(20);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as Bin }, kBlob, ct as Bin));
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

