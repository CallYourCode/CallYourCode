/* THE PATH PROBE, on its own.
 *
 * binaryOnPath is the one place the availability feature touches the real host
 * PATH. It is a module of its own so it can be proven here without a route or
 * an engine: a binary that exists on every POSIX box (sh), a name that cannot
 * (a nonsense string), and the empty string the places computation passes for
 * a launch command with no program token. The empty-string case is load
 * bearing: /new-session/places relies on binaryOnPath("") being false.
 *
 *   bun test agent-engine/src/runtime/which.test.ts
 */

import { test, expect } from "bun:test";

import { binaryOnPath } from "./which.ts";

test("a binary on PATH resolves true", () => {
  expect(binaryOnPath("sh")).toBe(true);
});

test("a name that is on no PATH resolves false", () => {
  expect(binaryOnPath("cyc-definitely-not-a-binary")).toBe(false);
});

test("the empty string resolves false (the places no-token case)", () => {
  expect(binaryOnPath("")).toBe(false);
});
