import { test, expect } from "bun:test";

test("RTC glue is wired before either signaling listener can accept an offer", async () => {
  const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();
  const glue = source.indexOf("initRtcGlue({");
  const relay = source.indexOf("relayLink.start();");
  const listen = source.indexOf("const server = Bun.serve<SockData>({");
  expect(glue).toBeGreaterThan(0);
  expect(glue).toBeLessThan(relay);
  expect(glue).toBeLessThan(listen);
  // Outbound relay dials only after the sealed client's frame/tunnel wiring.
  expect(relay).toBeGreaterThan(source.indexOf("initTunnel({"));
});
