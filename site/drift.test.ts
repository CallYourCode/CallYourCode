// site/drift.test.ts -- guards the served installer against drift.
//
// scripts/install.sh is the single source of truth. site/build.sh copies it to
// site/install.sh so Cloudflare Pages can serve it verbatim at
// https://callyourcode.com/install.sh. This test fails the moment the two
// files differ, so the committed copy stays faithful to the source and CI can
// catch a stale copy before it ships.
//
// Run: bun test site/drift.test.ts

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const source = join(repoRoot, "scripts", "install.sh");
const copy = join(repoRoot, "site", "install.sh");

test("site/install.sh is a byte-identical copy of scripts/install.sh", () => {
  const sourceBytes = readFileSync(source);
  const copyBytes = readFileSync(copy);
  expect(copyBytes.length).toBe(sourceBytes.length);
  // Buffer.equals gives a byte-for-byte comparison; the message points at the
  // fix so a failure is self-explanatory in CI.
  const identical = copyBytes.equals(sourceBytes);
  if (!identical) {
    throw new Error(
      "site/install.sh has drifted from scripts/install.sh. " +
        "Run `sh site/build.sh` to regenerate the copy, then commit it.",
    );
  }
  expect(identical).toBe(true);
});
