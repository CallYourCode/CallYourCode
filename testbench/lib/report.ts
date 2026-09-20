/* verdict.json files -> summary.json, summary.md, junit.xml. Pure. */

export type CellVerdict = {
  cell: string; harness: string; version: string; mux: string; scenario: string;
  verdict: "green" | "red" | "error" | "skipped";
  reason: string;
  checks?: { name: string; ok: boolean; detail: string }[];
  /** what the cell measured (13-version-gate: detected version, supported) */
  facts?: Record<string, unknown>;
  artifacts?: Record<string, string>;
  ms?: number;
  /** the runner's exit code for the container */
  rc?: number;
  /** artifacts dir, relative to testbench/ */
  dir?: string;
  /** the expected verdict: from the expectation map when one is in use, else
   *  the lane-1 rule; "(unlisted)" when the map does not name the cell */
  expected?: "green" | "red" | "(unlisted)";
};

export type ImageSize = {
  image: string;
  /** `docker image inspect .Size`: the content size (compressed layers under the containerd store) */
  size: string;
  /** `docker images` SIZE column: what the image takes on disk */
  disk?: string;
};

export type Summary = {
  tier: string | null;
  only: string | null;
  startedAt: string;
  wallMs: number;
  counts: Record<string, number>;
  /** cells whose verdict differs from the expectation table */
  surprises: { cell: string; expected: string; got: string; reason: string }[];
  /** the expectation file the surprises were judged against, if any */
  expectedFrom?: string | null;
  cells: CellVerdict[];
  images: ImageSize[];
};

/** Lane 1 expectation on today's tree (design 10, lane 1): 1 to 11 red, 12 and
 *  13 green for primary pins. A green where red is expected is a spec
 *  finding, reported, never "fixed" by weakening the scenario. */
export function expectedVerdict(scenario: string): "green" | "red" {
  const n = Number(scenario.slice(0, 2));
  return n === 12 || n === 13 ? "green" : "red";
}

export function summarize(cells: CellVerdict[], opts: {
  tier: string | null; only: string | null; startedAt: number; images?: ImageSize[];
  /** the checked-in expectation map (cell -> verdict); without it the lane-1 rule applies */
  expected?: { cells: Record<string, "green" | "red">; path?: string } | null;
}): Summary {
  const counts: Record<string, number> = { green: 0, red: 0, error: 0, skipped: 0 };
  const surprises: Summary["surprises"] = [];
  for (const c of cells) {
    counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
    c.expected = opts.expected ? opts.expected.cells[c.cell] ?? "(unlisted)" : expectedVerdict(c.scenario);
    if (c.verdict !== c.expected && c.verdict !== "skipped") surprises.push({ cell: c.cell, expected: c.expected, got: c.verdict, reason: c.expected === "(unlisted)" ? `not in the expectation map; ${c.reason}` : c.reason });
  }
  return { tier: opts.tier, only: opts.only, startedAt: new Date(opts.startedAt).toISOString(), wallMs: Date.now() - opts.startedAt, counts, surprises, expectedFrom: opts.expected?.path ?? null, cells, images: opts.images ?? [] };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function summaryMarkdown(s: Summary): string {
  const lines: string[] = [];
  lines.push(`# testbench summary`);
  lines.push(``);
  lines.push(`tier: ${s.tier ?? "(only)"}${s.only ? `  only: ${s.only}` : ""}  started: ${s.startedAt}  wall: ${(s.wallMs / 1000).toFixed(0)} s`);
  lines.push(`green ${s.counts.green ?? 0}  red ${s.counts.red ?? 0}  error ${s.counts.error ?? 0}  skipped ${s.counts.skipped ?? 0}`);
  lines.push(``);
  if (s.surprises.length) {
    lines.push(`## Surprises (verdict differs from ${s.expectedFrom ? `the expectation map ${s.expectedFrom}` : "the lane-1 expectation"})`);
    for (const x of s.surprises) lines.push(`- ${x.cell}: expected ${x.expected}, got ${x.got}: ${x.reason}`);
    lines.push(``);
  }
  lines.push(`## Cells (scenario x harness x mux)`);
  lines.push(``);
  lines.push(`| scenario | harness | mux | verdict | expected | reason | artifacts |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  const sorted = [...s.cells].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.harness.localeCompare(b.harness) || a.mux.localeCompare(b.mux));
  for (const c of sorted) {
    const reason = c.reason.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);
    lines.push(`| ${c.scenario} | ${c.harness} ${c.version} | ${c.mux} | ${c.verdict} | ${c.expected ?? ""} | ${reason} | ${c.dir ?? ""} |`);
  }
  const facts = sorted.filter((c) => c.facts && Object.keys(c.facts).length);
  if (facts.length) {
    lines.push(``);
    lines.push(`## Facts (what the cells measured)`);
    for (const c of facts) lines.push(`- ${c.cell}: ${Object.entries(c.facts!).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`);
  }
  if (s.images.length) {
    lines.push(``);
    lines.push(`## Images (content = \`docker image inspect .Size\`, the compressed layers; on disk = the \`docker images\` SIZE column)`);
    for (const i of s.images) lines.push(`- ${pad(i.image, 40)} content ${i.size}, on disk ${i.disk ?? "?"}`);
  }
  return lines.join("\n") + "\n";
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function junitXml(s: Summary): string {
  const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`];
  const failures = s.cells.filter((c) => c.verdict === "red").length;
  const errors = s.cells.filter((c) => c.verdict === "error").length;
  const skipped = s.cells.filter((c) => c.verdict === "skipped").length;
  out.push(`<testsuites name="cyc-testbench" tests="${s.cells.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(s.wallMs / 1000).toFixed(1)}">`);
  const byScenario = new Map<string, CellVerdict[]>();
  for (const c of s.cells) byScenario.set(c.scenario, [...(byScenario.get(c.scenario) ?? []), c]);
  for (const [scenario, cells] of byScenario) {
    out.push(`  <testsuite name="${xml(scenario)}" tests="${cells.length}" failures="${cells.filter((c) => c.verdict === "red").length}" errors="${cells.filter((c) => c.verdict === "error").length}" skipped="${cells.filter((c) => c.verdict === "skipped").length}">`);
    for (const c of cells) {
      out.push(`    <testcase classname="${xml(`${c.harness}.${c.version}.${c.mux}`)}" name="${xml(c.cell)}" time="${((c.ms ?? 0) / 1000).toFixed(1)}">`);
      if (c.verdict === "red") out.push(`      <failure message="${xml(c.reason)}">${xml((c.checks ?? []).filter((k) => !k.ok).map((k) => `${k.name}: ${k.detail}`).join("\n"))}</failure>`);
      else if (c.verdict === "error") out.push(`      <error message="${xml(c.reason)}"/>`);
      else if (c.verdict === "skipped") out.push(`      <skipped message="${xml(c.reason)}"/>`);
      out.push(`    </testcase>`);
    }
    out.push(`  </testsuite>`);
  }
  out.push(`</testsuites>`);
  return out.join("\n") + "\n";
}
