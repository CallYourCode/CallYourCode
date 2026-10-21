import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as e2e from "../../../shared/e2e";

const SURFACE = new URL("../../../shared/fixtures/e2e-surface.json", import.meta.url).pathname;
const expected: string[] = JSON.parse(readFileSync(SURFACE, "utf8")).exports;

test("shared e2e exposes exactly the pinned runtime export surface", () => {
  const actual = Object.keys(e2e).sort();
  expect(actual).toEqual([...expected].sort());
});
