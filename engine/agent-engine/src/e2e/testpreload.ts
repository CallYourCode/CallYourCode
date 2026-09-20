/* THE E2E PRELOAD: install the transport seam.
 *
 * Loaded by `bun test --preload ./e2e/testpreload.ts` (the `test:e2e` script),
 * so it runs once per e2e test process before any test file and swaps
 * `globalThis.WebSocket` for the `TestClient` shim (testclient.ts), which takes
 * the hello onto a real WebRTC DataChannel and runs the client half of the v2
 * sec handshake.
 *
 * It used to be a `bunfig.toml [test] preload`, which meant EVERY bun test
 * process in the repo loaded node-datachannel and a global WebSocket swap to
 * run a pure unit test about cron arithmetic. The four files that need the real
 * transport are the four under e2e/, and they are the only ones that get it.
 */
import "../test-utils/homeguard.ts"; // first: the fake HOME, before anything reads the env
import { TestClient } from "./testclient.ts";

globalThis.WebSocket = TestClient as unknown as typeof WebSocket;
