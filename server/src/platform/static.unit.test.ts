/* static.ts as a unit: which headers each kind of answer carries, the sandbox
 * shell exception, the cache split, and the traversal wall. The live-process
 * proof of the same headers stays in hardening.test.ts. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clerkFrontendOrigin } from "../access/clerk-key";
import { serveStatic, CSP, SANDBOX_SHELL } from "./static";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

async function dist(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cyc-static-unit-"));
  dirs.push(d);
  await writeFile(join(d, "index.html"), "<html></html>");
  await writeFile(join(d, "cyc-sw.js"), "// sw");
  await writeFile(join(d, "app-Ab12Cd34Ef.js"), "// hashed");
  await writeFile(join(d, "plain.js"), "// not hashed");
  await writeFile(join(d, SANDBOX_SHELL), "<html></html>");
  return d;
}

test("/ serves index.html with the CSP and no-cache", async () => {
  const d = await dist();
  const r = await serveStatic(d, "/");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toBe(CSP);
  expect(r.headers.get("cache-control")).toContain("no-store");
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
});

test("the service worker rides with the CSP set (document-shaped trust)", async () => {
  const d = await dist();
  const r = await serveStatic(d, "/cyc-sw.js");
  expect(r.headers.get("content-security-policy")).toBe(CSP);
  expect(r.headers.get("cache-control")).toContain("no-store");
});

test("hashed assets: immutable cache, baseline headers, no CSP", async () => {
  const d = await dist();
  const r = await serveStatic(d, "/app-Ab12Cd34Ef.js");
  expect(r.headers.get("cache-control")).toContain("immutable");
  expect(r.headers.get("content-security-policy")).toBeNull();
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
});

test("un-hashed assets get neither cache directive", async () => {
  const d = await dist();
  const r = await serveStatic(d, "/plain.js");
  expect(r.headers.get("cache-control")).toBeNull();
  expect(r.headers.get("content-security-policy")).toBeNull();
});

test("the sandbox shell is the one exception: its own policy, embeddable", async () => {
  const d = await dist();
  const r = await serveStatic(d, `/${SANDBOX_SHELL}`);
  const csp = r.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("sandbox allow-scripts");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(r.headers.get("x-frame-options")).toBeNull(); // the app embeds it
});

test("traversal cannot leave DIST_DIR; missing files answer 404", async () => {
  const d = await dist();
  const evil = await serveStatic(d, "/../../etc/passwd");
  expect([403, 404]).toContain(evil.status);
  expect((await serveStatic(d, "/never-built.js")).status).toBe(404);
});

test("clerkFrontendOrigin decodes both publishable-key payload formats", () => {
  // classic: base64("<host>$")
  const classic = "pk_test_" + btoa("clerk.example.com$");
  expect(clerkFrontendOrigin(classic)).toBe("https://clerk.example.com");
  // newer: base64url JSON {"iss": "https://<host>"}
  const payload = btoa(JSON.stringify({ iss: "https://foo.clerk.accounts.dev" }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(clerkFrontendOrigin("pk_live_" + payload)).toBe("https://foo.clerk.accounts.dev");
  // garbage in, null out: never a broken CSP token
  expect(clerkFrontendOrigin("")).toBeNull();
  expect(clerkFrontendOrigin("pk_test_%%%%")).toBeNull();
  expect(clerkFrontendOrigin("not-a-key")).toBeNull();
});
