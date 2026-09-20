/* ------------------------------------------------------------- bug reports
 *
 * ONE FILE PER REPORT, and the id is the filename. `r-<ms in base36>-<rand>`,
 * so keeping the newest REPORT_KEEP is a directory listing and a slice rather
 * than anything that has to read what is inside them.
 *
 * TWO THINGS MAKE THAT SORT TRUE, and both were measured false first:
 *
 *   - THE MILLISECOND IS PADDED to nine base36 digits. Unpadded it is eight
 *     today and nine from 2059, and a shorter string sorts BEFORE a longer one
 *     whatever the number says, so the reap would start eating the newest
 *     reports on that day. Nine digits is fixed width until the year 5138.
 *   - THE CLOCK IS MADE STRICTLY INCREASING within this process. Two reports
 *     filed in the same millisecond used to be ordered by their random tails,
 *     i.e. not ordered at all. Measured by report.test.ts filing 205 in a
 *     burst: the five that were reaped were five arbitrary ones, and the claim
 *     "the oldest go" was simply untrue. A phone cannot press a button twice in
 *     a millisecond, so this is about the test being able to prove the rule
 *     rather than about him -- but a rule that only holds when nobody is
 *     looking quickly is not the rule the comment claims.
 *
 * Nothing here is a merge or an index: the whole point of the shape is that
 * `cat ~/.callyourcode/app-server/reports/r-*.json` is a complete answer, from
 * a shell, from a lane, from anywhere. scripts/reports.sh is a convenience
 * over exactly that. */

import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { REPORT_KEEP } from "../platform/caps";

let lastReportMs = 0;
export const reportId = () => {
  lastReportMs = Math.max(Date.now(), lastReportMs + 1);
  return `r-${lastReportMs.toString(36).padStart(9, "0")}-` +
    `${Math.random().toString(36).slice(2, 7)}`;
};

/** A stored report's path, refusing anything that is not one of our ids. This
 *  is the only place a request's string reaches the filesystem. */
export function reportPath(dir: string, id: string): string | null {
  return /^r-[a-z0-9]{1,12}-[a-z0-9]{1,8}$/.test(id) ? join(dir, `${id}.json`) : null;
}

/** One line of text off the wire, made safe to store and to read back. */
export const reportText = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").slice(0, max);

/** Newest first. The filename carries the time, so nothing is opened. */
export async function reportFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.startsWith("r-") && f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];   // nothing has ever been filed here
  }
}

/* Past `keep`, the oldest go. His logs are large and this directory is fed by
 * a button on a phone; an unbounded writer under a thumb is how .run/uploads
 * reached 215 files. */
export async function reapReports(dir: string, keep = REPORT_KEEP): Promise<number> {
  const files = await reportFiles(dir);
  let gone = 0;
  for (const f of files.slice(keep)) {
    await unlink(join(dir, f)).then(() => { gone++; }).catch(() => {});
  }
  return gone;
}
