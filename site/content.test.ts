// Run: bun test site/content.test.ts
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const site = import.meta.dir;
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? pages(path) : entry.name.endsWith(".html") ? [path] : [];
  });
}

for (const path of pages(site)) {
  test(`${relative(site, path)} describes only local or Tailscale access`, () => {
    const html = readFileSync(path, "utf8");
    expect(html).not.toMatch(/app\.callyourcode\.com|\b(?:WebRTC|DataChannel|TURN|STUN|hosted|cloud)\b/i);
    expect(html).not.toContain("btn-login");
  });
}
