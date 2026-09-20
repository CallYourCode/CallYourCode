/* Where a run's artifacts go, what the tier record is, and what "the set
 * matches" means for the exit code. Pure except the two fs helpers.
 *
 *   artifacts/summary.{json,md} + junit.xml + cells/   the tier record (a full
 *                                                      `--tier` run, no --only)
 *   artifacts/history/<startedAt>/summary.*            the previous tier record,
 *                                                      archived before a full run
 *   artifacts/only/<stamp>/{cells,summary.*}           every --only run; the tier
 *                                                      record is never touched
 *   expected/pr.json                                   cell -> expected verdict,
 *                                                      checked in; a run exits 1
 *                                                      on any surprise */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Summary } from "./report.ts";

export type ExpectedVerdict = "green" | "red";
export type Expected = {
  /** startedAt of the summary the map was last generated from */
  generatedFrom: string | null;
  cells: Record<string, ExpectedVerdict>;
};

export type Surprise = { cell: string; expected: string; got: string; reason: string };

/** a filesystem-safe timestamp: 2026-09-02T10-30-15Z */
export const stamp = (d: Date | string = new Date()): string => new Date(d).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

/** the artifacts root for this invocation: the tier record, or a fresh
 *  only/<stamp> dir for a --only run */
export function runRoot(artifactsDir: string, only: string | null, now: Date = new Date()): string {
  return only ? join(artifactsDir, "only", stamp(now)) : artifactsDir;
}

/** copy the tier record's summary files aside before a full run overwrites
 *  them; the dir is named by the archived summary's own startedAt */
export function archivePrevious(artifactsDir: string, now: Date = new Date()): string | null {
  const src = join(artifactsDir, "summary.json");
  if (!existsSync(src)) return null;
  let started = "";
  try { started = String(JSON.parse(readFileSync(src, "utf8")).startedAt ?? ""); } catch { /* unreadable: stamp by now */ }
  const dir = join(artifactsDir, "history", stamp(started && !Number.isNaN(Date.parse(started)) ? started : now));
  mkdirSync(dir, { recursive: true });
  for (const f of ["summary.json", "summary.md", "junit.xml"]) if (existsSync(join(artifactsDir, f))) copyFileSync(join(artifactsDir, f), join(dir, f));
  return dir;
}

export function readExpected(path: string): Expected | null {
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { generatedFrom: j.generatedFrom ?? null, cells: j.cells ?? {} };
}

/** the expectation map from a summary's verdicts, merged over a previous map
 *  (a partial --only summary updates only the cells it ran). Cells that
 *  errored carry no verdict and are left as they were. */
export function expectedFromSummary(s: Pick<Summary, "cells" | "startedAt">, prev: Expected | null = null): Expected {
  const cells: Record<string, ExpectedVerdict> = { ...(prev?.cells ?? {}) };
  for (const c of s.cells) if (c.verdict === "green" || c.verdict === "red") cells[c.cell] = c.verdict;
  const sorted = Object.fromEntries(Object.keys(cells).sort().map((k) => [k, cells[k]]));
  return { generatedFrom: s.startedAt, cells: sorted };
}

export function writeExpected(path: string, e: Expected): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(e, null, 2) + "\n");
}

/** 0 when every cell matched its expectation (summarize() lists the
 *  surprises, either direction, unlisted cells included), 1 on any surprise
 *  or error: the design's "fails the PR" */
export function exitCode(s: Pick<Summary, "surprises" | "counts">): number {
  return s.surprises.length || s.counts.error ? 1 : 0;
}

/** the printed diff against the expectation */
export function diffText(d: Surprise[], from: string | null): string {
  const vs = from ? `against ${from}` : "against the lane-1 rule";
  if (!d.length) return `expected ${vs}: every cell matched`;
  return [`expected ${vs}: ${d.length} surprise(s)`, ...d.map((x) => `  ${x.cell}: expected ${x.expected}, got ${x.got}: ${x.reason.slice(0, 200)}`)].join("\n");
}
