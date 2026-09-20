/* The STUN/TURN service (turn-server, pure JS, zero-dep). Bound to all
 * interfaces so it is reachable at the box's TAILNET address on 3478.
 *
 * STUN is the path that matters: a tailnet client STUN-queries this over
 * tailscale and gets its own tailscale IP back, so ICE forms the direct
 * tailscale candidate pair (browsers hide host IPs behind mDNS, which is why
 * host candidates alone did not connect). TURN is the wired fallback for
 * off-tailnet / hostile networks, using the same static-auth-secret the
 * app-server mints REST credentials for (engine/shared/turn.ts). No sudo:
 * 3478 is unprivileged and this is a bun-installed JS dep, no system package.
 */
import { createServer } from "turn-server";

const PORT = Number(process.env.TURN_PORT ?? 3478);
const REALM = process.env.TURN_REALM ?? "callyourcode";
const SECRET = process.env.TURN_STATIC_SECRET ?? "";
const EXTERNAL_IP = process.env.TURN_EXTERNAL_IP; // the box's tailnet IP, for TURN relay candidates
const RELAY: [number, number] = [
  Number(process.env.TURN_RELAY_MIN ?? 49160),
  Number(process.env.TURN_RELAY_MAX ?? 49200),
];

if (!SECRET) {
  console.error("turn: TURN_STATIC_SECRET is required");
  process.exit(1);
}

const server = createServer({
  software: "callyourcode-turn",
  auth: { mechanism: "long-term", realm: REALM, secret: SECRET },
  relay: { ip: "0.0.0.0", externalIp: EXTERNAL_IP, portRange: RELAY },
});

server.on("listening", (info) =>
  console.log(`turn listening ${info.address}:${info.port}/${info.transport} realm=${REALM} ext=${EXTERNAL_IP ?? "(none)"}`));
server.on("error", (e) => console.error("turn error", (e as Error)?.message ?? e));

server.listen([
  { transport: "udp", port: PORT },
  { transport: "tcp", port: PORT },
]);

process.on("SIGTERM", () => server.drain(5000, () => process.exit(0)));
