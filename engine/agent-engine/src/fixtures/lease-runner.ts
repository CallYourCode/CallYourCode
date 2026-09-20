/* ONE ENGINE CONTENDING FOR THE READING LEASE, run as a real `bun` child by
 * lease-race.test.ts.
 *
 * WHY IT IS A FILE AND NOT A STRING IN THE TEST, the same argument
 * lock-runner.ts makes: a template literal written into a tmp dir would put
 * `setTimeout(..., n)` and a hold loop inside a *.test.ts, which the suite's own
 * gates grep for and cannot tell apart from a test that really sleeps. A fixture
 * is not a test file, so the contender may hold and yield here exactly as a real
 * engine does, and the spec stays honest about never sleeping itself.
 *
 *   CYC_LIMITS_SHARE_DIR=<dir> bun run lease-runner.ts <rounds>
 *
 * Each round: keep asking for the lease until this process has had its turn,
 * hold it for a few milliseconds, print the interval it believed it held, and
 * release. One line per hold:
 *
 *   HELD <pid> <fromMs> <toMs>
 *
 * A CONTENDED ROUND IS RETRIED, NOT SKIPPED. The first version of this gave up
 * on `busy` and moved on, so twelve processes racing thirty rounds produced
 * twenty-seven holds between them: the losers simply ran out of rounds while the
 * winner worked, and the sample was far too small to catch a race that needs a
 * reader to land inside a writer. Everybody keeps trying until they have had
 * their turn, which is what turns a couple of hundred holds into thousands of
 * claim attempts.
 */

import { releaseLease, takeLease } from "../storage/limits-share.ts";

const ACCOUNT = "someone@example.com";
const rounds = Number(process.argv[2] ?? 0);

for (let round = 0; round < rounds; round++) {
  let res: Awaited<ReturnType<typeof takeLease>> | null = null;
  for (let tries = 0; tries < 5000; tries++) {
    res = await takeLease(ACCOUNT);
    if (res.kind === "taken") break;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (res?.kind !== "taken") continue;
  const from = Date.now();
  /* Long enough that a lease stolen out from under this one overlaps by MORE
   * than the millisecond Date.now() can see. The whole verdict is arithmetic on
   * these two numbers, so a hold shorter than the clock's resolution would
   * report overlaps as coincidences and coincidences as overlaps. */
  await new Promise((r) => setTimeout(r, 5));
  console.log(`HELD ${process.pid} ${from} ${Date.now()}`);
  await releaseLease(res.lease);
}
