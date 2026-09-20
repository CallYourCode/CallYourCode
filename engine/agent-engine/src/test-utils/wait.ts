/* THE ONLY FILE IN THE UNIT AND SEAM TIERS ALLOWED TO SLEEP.
 *
 * Logical time is the manual clock (../runtime/clock.ts): a batch window, a retry
 * ladder, a lease going stale. None of that waits here.
 *
 * What DOES genuinely take real time is real async I/O the test started: a
 * JSON-RPC round trip to a FakeHerdr over a unix socket, a fetch against a
 * port-0 Bun.serve, a file the engine writes from a promise chain. There is no
 * logical clock to advance for those, so the honest shape is to poll a
 * condition at a small interval with a bound, and fail loudly with the
 * caller's own sentence when the bound is reached. That is `until`.
 *
 * `gates.test.ts` greps for Bun.sleep and allows it only here and under e2e/.
 */

/** Poll `cond` every 5ms until it is true. Throws with `what` on timeout. */
export async function until(
  cond: () => boolean | Promise<boolean>,
  o: { timeoutMs?: number; what?: string } = {},
): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${o.what ?? "a condition"}`);
    }
    await Bun.sleep(5);
  }
}

/** until(), but hands back the first truthy value the probe produced. */
export async function untilValue<T>(
  probe: () => T | undefined | null | Promise<T | undefined | null>,
  o: { timeoutMs?: number; what?: string } = {},
): Promise<T> {
  let got: T | undefined | null;
  await until(async () => {
    got = await probe();
    return got != null;
  }, o);
  return got as T;
}

/** Wait for an array to reach `n` entries. The shape most seam assertions want:
 *  "the fake herdr received two send_texts". */
export async function untilCount(
  list: { length: number },
  n: number,
  o: { timeoutMs?: number; what?: string } = {},
): Promise<void> {
  await until(() => list.length >= n, { ...o, what: o.what ?? `${n} entries (saw ${list.length})` });
}

/** Let the microtask queue and one macrotask turn drain. For code that resolves
 *  on its own promise chain with no observable to poll. */
export async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await Bun.sleep(0);
}
