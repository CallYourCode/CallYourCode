/* 13. version gate (design 9, scenario 13)
 *
 * given  a harness at a pinned version (the tier's primary, or in the nightly
 *        tier one of the compat pins; CELL_VERSIONS lists primary first)
 * when   bring-up runs
 * then   the cell proves which binary it drove (`<harness> --version` equals
 *        the pin), the row shows the detected version, and the verdict
 *        records supported / unsupported for that version.
 *
 * "supported / unsupported" is the ENGINE's verdict, so the check reads it
 * from evidence the engine produced: a version field on the wire row, or an
 * engine log line naming the detected version together with a supported or
 * unsupported decision. The pin list the cell was launched with is the
 * scenario's given, never its evidence; an engine that exposes no version
 * verdict is red with that reason (a spec finding), on every pin. */

import type { Cell } from "../cell/driver.ts";
import { bringUp } from "./_lib.ts";

const VERSION_ARGV: Record<string, string[]> = {
  claude: ["claude", "--version"],
  codex: ["codex", "--version"],
  opencode: ["opencode", "--version"],
  pi: ["pi", "--version"],
};

const semver = (s: string) => (s.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/) ?? [""])[0];

export default async function (c: Cell) {
  const argv = VERSION_ARGV[c.harnessName];
  const pins = (process.env.CELL_VERSIONS ?? c.version).split(",").map((s) => s.trim()).filter(Boolean);
  const primary = pins[0] ?? c.version;
  const isPrimary = c.version === primary;
  const supported = pins.includes(c.version);
  c.fact("pin", c.version);
  c.fact("primary", primary);
  c.fact("compat", pins.slice(1));

  /* the binary the cell drives: its own idea of its version */
  const p = Bun.spawnSync(argv, { env: { ...process.env, ...c.harness().paneEnv(c.paths, c.fakeUrl, c.enginePort) }, timeout: 20_000 });
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  const detected = semver(out);
  c.fact("detected", detected);
  c.expect(`${argv.join(" ")} reports the pinned version`, p.exitCode === 0 && detected === semver(c.version), `got ${JSON.stringify(out.slice(0, 120))}, pin ${c.version}`);

  /* bring-up on that version */
  const { row, transcript } = await bringUp(c);
  c.expect("bring-up on this version yields a live row", !!row, row ? `row ${row.id}` : "no row");
  c.expect("the harness wrote a transcript on this version", !!transcript, transcript?.path ?? "none");

  /* the row's version, as the wire shows it (spec: harness.version / version) */
  const rowVersion = String((row as any)?.harness?.version ?? (row as any)?.harnessVersion ?? (row as any)?.version ?? "");
  const badge = String((row as any)?.badge ?? (row as any)?.harness?.badge ?? "");
  c.fact("rowVersion", rowVersion || null);
  c.fact("rowBadge", badge || null);
  c.fact("supported", supported);
  c.fact("verdictFor", `${c.harnessName} ${c.version}: ${supported ? "supported" : "unsupported"}${isPrimary ? " (primary)" : " (compat)"}`);
  if (!isPrimary) {
    c.expect("the row shows the detected version", semver(rowVersion) === detected, `row version ${JSON.stringify(rowVersion)}, detected ${detected}`);
    c.expect("an unsupported version is badged; a supported one is not", supported ? !/unsupported/i.test(badge) : /unsupported/i.test(badge), `supported=${supported} badge=${JSON.stringify(badge)}`);
  } else if (semver(rowVersion) !== detected) {
    c.log(`spec gap (recorded, not failed on the primary pin): the row carries no version field; keys=${Object.keys(row ?? {}).join(",")}`);
  }
  /* the engine's own version verdict, from its evidence: a version on the row,
   * or an engine log line naming the detected version and the decision */
  const keys = Object.keys(row ?? {}).sort();
  const rowNames = !!detected && semver(rowVersion) === detected;
  const verdictLines = c.engine().lines.filter((l) => !!detected && l.includes(detected) && /\b(un)?supported\b/i.test(l));
  const rowDecision = /\b(un)?supported\b/i.test(badge) ? badge : "";
  const exposed = (rowNames && !!rowDecision) || verdictLines.length > 0;
  c.expect("the engine exposes a version verdict (the detected version and its supported/unsupported decision, on the wire row or in its log)", exposed,
    exposed
      ? `${rowNames ? `row version ${JSON.stringify(rowVersion)}${rowDecision ? ` badge ${JSON.stringify(rowDecision)}` : ""}` : ""}${verdictLines.length ? `${rowNames ? "; " : ""}engine log: ${verdictLines[0].slice(0, 160)}` : ""}`
      : `engine exposes no version verdict: ${rowNames ? `the row names ${detected} but carries no supported/unsupported decision` : `no version field on the row (keys=${keys.join(",")})`}`
        + `, no engine log line names the detected version ${detected || "(none detected)"} with a supported/unsupported decision (${c.engine().lines.length} lines searched)`
        + `; the cell's own given was ${JSON.stringify(c.facts.verdictFor)}`);
}
