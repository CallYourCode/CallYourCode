/* THE IMPORT GATE: the reader-seam bypass, enforced.
 *
 * carry.ts, lineage.ts, context-cache.ts, routes/session-ops.ts and server.ts
 * used to value-import session-events.ts and read transcripts themselves. Now
 * they reach every transcript fact through the adapter's
 * verbs, and readers/ is the ONLY home for session-events values again. This
 * test fails the moment any of the five grows a value import of session-events
 * back -- a type-only import is still allowed, since a type erases at build and
 * carries no reader dependency.
 *
 *   bun test agent-engine/src/runtime/import-gates.test.ts
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const GATED = [
  "sessions/carry.ts",
  "sessions/lineage.ts",
  "sessions/context-cache.ts",
  "routes/session-ops.ts",
  "runtime/server.ts",
];

/** Every `import ... from "...session-events..."` statement in a source file,
 *  whole (multi-line imports included). An import statement carries no `;`
 *  before its `from`, so a `;`-free run up to the specifier is one statement. */
function sessionEventsImports(src: string): string[] {
  const re = /import\b[^;]*?from\s*["'][^"']*session-events(?:\.ts)?["']/g;
  return src.match(re) ?? [];
}

for (const rel of GATED) {
  test(`${rel} has no VALUE import of session-events.ts`, () => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const imports = sessionEventsImports(src);
    for (const stmt of imports) {
      // `import type { ... }` is fine (types erase); a bare `import { ... }` is
      // the value import the seam forbids.
      expect(
        /^import\s+type\b/.test(stmt),
        `${rel} value-imports session-events.ts:\n  ${stmt.replace(/\s+/g, " ")}\n` +
          `Route the transcript fact through an adapter verb instead.`,
      ).toBe(true);
    }
  });
}

test("the gate regex actually catches a value import (self-check)", () => {
  const bad = `import { sessionFilePath } from "../sessions/session-events.ts";`;
  const ok = `import type { SessionEvent } from "../sessions/session-events.ts";`;
  const none = `import { sessionFilePath } from "../readers/claude.ts";`;
  expect(sessionEventsImports(bad).length).toBe(1);
  expect(/^import\s+type\b/.test(sessionEventsImports(bad)[0])).toBe(false);
  expect(/^import\s+type\b/.test(sessionEventsImports(ok)[0])).toBe(true);
  expect(sessionEventsImports(none).length).toBe(0);
});
