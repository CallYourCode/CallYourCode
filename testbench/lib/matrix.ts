/* matrix.yaml: load, validate, expand a tier into cells. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type HarnessSpec = { package: string; primary: string; compat: string[]; dialect: string };
export type MuxSpec = { primary: string; compat: string[]; in_docker?: boolean };
export type ScenarioSpec = { id: string; mux?: "both"; per_version?: boolean };
export type TierSpec = {
  enabled: boolean;
  harnesses: string[];
  versions: "primary" | "primary+compat";
  muxes: string[];
  tmux_versions?: "primary" | "primary+compat";
  scenarios: "all" | string[];
  jobs?: number;
  network?: string;
};
export type Matrix = {
  images: { base: string; base_tag: string };
  harnesses: Record<string, HarnessSpec>;
  muxes: Record<string, MuxSpec>;
  cell: { network: string; memory: string; cpus: number; pids_limit: number; cap_add?: string[]; timeout_s: number; engine_port: number; fake_model_port: number };
  scenarios: ScenarioSpec[];
  tiers: Record<string, TierSpec>;
};

export type Cell = {
  /** harness/version/mux/scenario, the cell id and its artifacts dir name */
  id: string;
  harness: string;
  version: string;
  /** tmux | herdr | both */
  mux: string;
  scenario: string;
  /** extra versions for a per_version scenario (13-version-gate) */
  versions?: string[];
};

export function loadMatrix(path = join(import.meta.dir, "..", "matrix.yaml")): Matrix {
  const text = readFileSync(path, "utf8");
  const m = Bun.YAML.parse(text) as Matrix;
  validateMatrix(m);
  return m;
}

export function validateMatrix(m: Matrix): void {
  if (!m.harnesses || !m.muxes || !m.tiers || !m.scenarios) throw new Error("matrix.yaml: missing top-level keys");
  for (const [name, h] of Object.entries(m.harnesses)) {
    if (!h.primary || !h.package) throw new Error(`matrix.yaml: harness ${name} needs package + primary`);
  }
  for (const [name, t] of Object.entries(m.tiers)) {
    for (const h of t.harnesses) if (!m.harnesses[h]) throw new Error(`matrix.yaml: tier ${name} names unknown harness ${h}`);
    for (const x of t.muxes) if (!m.muxes[x]) throw new Error(`matrix.yaml: tier ${name} names unknown mux ${x}`);
    if (Array.isArray(t.scenarios)) {
      for (const s of t.scenarios) if (!m.scenarios.find((q) => q.id === s)) throw new Error(`matrix.yaml: tier ${name} names unknown scenario ${s}`);
    }
  }
  if (m.tiers.real && m.tiers.real.enabled) {
    throw new Error("matrix.yaml: the real tier must stay enabled: false (owner turns it on by hand)");
  }
}

export function cellId(c: Omit<Cell, "id">): string {
  return `${c.harness}/${c.version}/${c.mux}/${c.scenario}`;
}

/** Expand a tier into cells (one per harness x version x mux x scenario). */
export function expandTier(m: Matrix, tierName: string): Cell[] {
  const tier = m.tiers[tierName];
  if (!tier) throw new Error(`unknown tier ${tierName}`);
  if (!tier.enabled) throw new Error(`tier ${tierName} is disabled in matrix.yaml`);
  const scenarios = tier.scenarios === "all" ? m.scenarios : m.scenarios.filter((s) => (tier.scenarios as string[]).includes(s.id));
  const cells: Cell[] = [];
  for (const harness of tier.harnesses) {
    const h = m.harnesses[harness];
    const versions = tier.versions === "primary+compat" ? [h.primary, ...h.compat] : [h.primary];
    for (const s of scenarios) {
      const muxes = s.mux === "both" ? ["both"] : tier.muxes;
      for (const version of versions) {
        for (const mux of muxes) {
          /* a per_version scenario (the version gate) carries the tier's pin
           * list so its verdict can say which pins the matrix knows */
          const c = s.per_version ? { harness, version, mux, scenario: s.id, versions } : { harness, version, mux, scenario: s.id };
          cells.push({ id: cellId(c), ...c });
        }
      }
    }
  }
  return cells;
}

/** --only harness/version/mux/scenario with `*` wildcards per segment;
 *  a missing trailing segment matches everything. */
/** `--only harness/version/mux/scenario`; each segment is a glob (`*`, `?`,
 *  `[2-8]`) or a comma list (`claude,pi`); an empty or missing segment is `*`.
 *  Several patterns can be joined with `;`. */
export function matchOnly(cell: Cell, only: string): boolean {
  return only.split(";").some((pat) => matchOne(cell, pat.trim()));
}
function matchOne(cell: Cell, only: string): boolean {
  const want = only.split("/");
  const have = cell.id.split("/");
  for (let i = 0; i < want.length; i++) {
    if (want[i] === "*" || want[i] === "") continue;
    if (!want[i].split(",").some((g) => globRe(g).test(have[i] ?? ""))) return false;
  }
  return true;
}
function globRe(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[") { const j = g.indexOf("]", i); if (j > i) { re += g.slice(i, j + 1); i = j; } else re += "\\["; }
    else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
