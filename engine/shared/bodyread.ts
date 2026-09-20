/* CAP EVERY REQUEST BODY A SERVICE IS WILLING TO BUFFER -- the mechanism.
 *
 * SECURITY-REVIEW #11: routes used to call req.json / req.text / req.arrayBuffer
 * with no ceiling. Those APIs read the whole stream into memory, so a client (or
 * a hostile page in the show sandbox) could POST gigabytes and the process would
 * hold them. This is the same idea on the way in, for any service that answers
 * HTTP.
 *
 * Content-Length, when it is a number and over the cap, is refused before any
 * byte is kept. A missing or lying Content-Length is still counted as the stream
 * arrives, and the read stops the moment the next chunk would pass the cap. The
 * overflowing chunk is not stored.
 *
 * THE NUMBERS ARE NOT HERE. A cap is a policy about one service's routes, and
 * the engine's live in agent-engine/src/storage/body-limits.ts beside the routes they bound.
 * Keeping them together was what made the app server's build graph reach
 * agent-engine/src/storage/docstate.ts -- for one constant, STATE_BODY_MAX_BYTES, that the
 * app server has no route for.
 *
 *   bun test agent-engine/src/storage/body-limits.test.ts
 */

export type CappedBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/* NO CORS GRANT on the refusal (H1 fix): the 413 used to carry the CORS
 * allow-origin wildcard, which let any web page read it cross-origin. Neither
 * service that shares this reader serves a cross-origin browser: the engine
 * grants no CORS at all now (httpx.ts), and the app server is same-origin
 * with the app it serves. */
export function bodyTooLarge(maxBytes: number): Response {
  return new Response(JSON.stringify({ error: "body too large", max: maxBytes }), {
    status: 413,
    headers: { "content-type": "application/json" },
  });
}

/** A body that streams straight through (never buffered) still must not
 *  forward a single byte when its declared Content-Length already exceeds the
 *  cap. Returns the 413 to send, or null when the body may stream on. */
export function declaredBodyTooLarge(req: Request, maxBytes: number): Response | null {
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) {
    void cancelBody(req);
    return bodyTooLarge(maxBytes);
  }
  return null;
}

function declaredLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw == null || raw === "") return null;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

async function cancelBody(req: Request): Promise<void> {
  try { await req.body?.cancel(); } catch { /* already closed or locked */ }
}

/** Raw bytes, or a 413 the route returns as-is. */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<CappedBody<Uint8Array>> {
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) {
    await cancelBody(req);
    return { ok: false, response: bodyTooLarge(maxBytes) };
  }

  const reader = req.body?.getReader();
  if (!reader) return { ok: true, value: new Uint8Array() };

  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (n + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, response: bodyTooLarge(maxBytes) };
    }
    chunks.push(value);
    n += value.byteLength;
  }

  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return { ok: true, value: out };
}

/** UTF-8 text of a capped body. */
export async function readTextCapped(req: Request, maxBytes: number): Promise<CappedBody<string>> {
  const got = await readBodyCapped(req, maxBytes);
  if (!got.ok) return got;
  return { ok: true, value: new TextDecoder().decode(got.value) };
}

/** Parsed JSON of a capped body. Invalid JSON becomes {}, matching the
 *  existing `req.json().catch(() => ({}))` on the control routes. */
export async function readJsonCapped(req: Request, maxBytes: number): Promise<CappedBody<unknown>> {
  const got = await readTextCapped(req, maxBytes);
  if (!got.ok) return got;
  if (!got.value) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(got.value) };
  } catch {
    return { ok: true, value: {} };
  }
}
