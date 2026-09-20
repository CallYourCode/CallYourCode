/* The ephemeral TURN credential mint (shared/turn.ts): the coturn
 * static-auth-secret scheme, proved against an independent recomputation.
 *
 *   bun test relay/turn.test.ts
 */

import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { mintTurn, turnEnv, verifyTurn, TURN_TTL_DEFAULT_S } from "../../../engine/shared/turn";

test("turnEnv parses TURN_URLS + secret and defaults the TTL", () => {
  expect(turnEnv({})).toBeNull();
  expect(turnEnv({ TURN_URLS: "turn:t:3478" })).toBeNull();       // no secret
  expect(turnEnv({ TURN_STATIC_SECRET: "s" })).toBeNull();        // no urls
  expect(turnEnv({ TURN_URLS: "http://nope", TURN_STATIC_SECRET: "s" })).toBeNull(); // not turn:
  const t = turnEnv({
    TURN_URLS: " turn:t.example.com:3478 , turns:t.example.com:5349?transport=tcp ",
    TURN_STATIC_SECRET: "s3cret",
  })!;
  expect(t.urls).toEqual(["turn:t.example.com:3478", "turns:t.example.com:5349?transport=tcp"]);
  expect(t.ttlS).toBe(TURN_TTL_DEFAULT_S);
  expect(turnEnv({ TURN_URLS: "turn:t:3478", TURN_STATIC_SECRET: "s", TURN_TTL_S: "600" })!.ttlS).toBe(600);
});

test("mintTurn: username is expiry:label, credential is HMAC-SHA1 the way coturn computes it", () => {
  const t = { urls: ["turn:t:3478"], secret: "s3cret", ttlS: 600 };
  const now = 1_755_000_000_000;
  const c = mintTurn(t, "user_abc", now);
  const expiry = Math.floor(now / 1000) + 600;
  expect(c.username).toBe(`${expiry}:user_abc`);
  // the independent recomputation: what coturn does with use-auth-secret
  expect(c.credential).toBe(createHmac("sha1", "s3cret").update(c.username!).digest("base64"));
  expect(c.urls).toEqual(["turn:t:3478"]);
});

test("labels are sanitized so a hostile sub cannot smuggle separators", () => {
  const t = { urls: ["turn:t:3478"], secret: "s", ttlS: 60 };
  const c = mintTurn(t, "user:with spaces/and$junk", 0);
  expect(c.username).toBe("60:userwithspacesandjunk");
});

test("verifyTurn accepts a live mint, refuses forgery and expiry", () => {
  const t = { urls: ["turn:t:3478"], secret: "s3cret", ttlS: 600 };
  const now = Date.now();
  const c = mintTurn(t, "user_abc", now);
  expect(verifyTurn("s3cret", c.username!, c.credential!, now)).toBe(true);
  expect(verifyTurn("wrong", c.username!, c.credential!, now)).toBe(false);
  expect(verifyTurn("s3cret", c.username!, "AAAA", now)).toBe(false);
  // past the expiry it is dead however good the HMAC is
  expect(verifyTurn("s3cret", c.username!, c.credential!, now + 601_000)).toBe(false);
});
