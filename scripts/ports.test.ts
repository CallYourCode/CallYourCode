/* resolvePorts (engine/shared/ports.ts): the CYC_PORT_BASE scheme. Pure env-in,
 * four-numbers-out, so every case is a plain object.
 *
 *   bun test scripts/ports.test.ts
 */

import { test, expect } from "bun:test";
import { resolvePorts } from "../engine/shared/ports.ts";

test("no base, no vars: today's exact defaults", () => {
  expect(resolvePorts({})).toEqual({
    APP_PORT: 10100, AGENT_PORT: 10101, VOICE_PORT: 10102, TURN_PORT: 3478,
  });
});

test("CYC_PORT_BASE derives all four: APP=B, AGENT=B+1, VOICE=B+2, TURN=B+3378", () => {
  expect(resolvePorts({ CYC_PORT_BASE: "20200" })).toEqual({
    APP_PORT: 20200, AGENT_PORT: 20201, VOICE_PORT: 20202, TURN_PORT: 23578,
  });
});

test("B=10100 reproduces the first THREE defaults by construction (TURN is B+3378, not 3478)", () => {
  const p = resolvePorts({ CYC_PORT_BASE: "10100" });
  expect([p.APP_PORT, p.AGENT_PORT, p.VOICE_PORT]).toEqual([10100, 10101, 10102]);
  expect(p.TURN_PORT).toBe(13478); // deliberately moved so two installs never share the one STUN port
});

test("an individual var ALWAYS wins over the base", () => {
  const p = resolvePorts({ CYC_PORT_BASE: "20200", AGENT_PORT: "9999", TURN_PORT: "3478" });
  expect(p.AGENT_PORT).toBe(9999); // pinned
  expect(p.TURN_PORT).toBe(3478); // pinned back to the historical port on purpose
  expect(p.APP_PORT).toBe(20200); // still derived
  expect(p.VOICE_PORT).toBe(20202);
});

test("an individual var wins over the DEFAULT when there is no base", () => {
  const p = resolvePorts({ APP_PORT: "8080" });
  expect(p.APP_PORT).toBe(8080);
  expect(p.AGENT_PORT).toBe(10101); // the rest stay at today's defaults
});

test("blank or non-numeric values are ignored (fall through to base, else default)", () => {
  expect(resolvePorts({ AGENT_PORT: "" }).AGENT_PORT).toBe(10101);
  expect(resolvePorts({ AGENT_PORT: "  " }).AGENT_PORT).toBe(10101);
  expect(resolvePorts({ CYC_PORT_BASE: "nope" })).toEqual({
    APP_PORT: 10100, AGENT_PORT: 10101, VOICE_PORT: 10102, TURN_PORT: 3478,
  });
  expect(resolvePorts({ CYC_PORT_BASE: "20200", VOICE_PORT: "x" }).VOICE_PORT).toBe(20202);
});
