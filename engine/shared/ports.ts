/* THE ONE PORT SCHEME (CYC_PORT_BASE), shared by every service so a second
 * install on one box moves all four ports with a single knob instead of the
 * four silent 10101 defaults that ate an afternoon apiece.
 *
 * The rule, exactly:
 *   - An individual var (APP_PORT / AGENT_PORT / VOICE_PORT / TURN_PORT) ALWAYS
 *     wins when set to a finite number: a deploy that pins one port keeps it.
 *   - Else, when CYC_PORT_BASE=B is a finite number, the four derive from it:
 *       APP_PORT   = B
 *       AGENT_PORT = B + 1
 *       VOICE_PORT = B + 2
 *       TURN_PORT  = B + 3378
 *     B=10100 reproduces the first THREE of today's defaults by construction
 *     (10100/10101/10102); TURN is deliberately B+3378, not the historical
 *     3478, because a moved base must move TURN too or two installs collide on
 *     the one unprivileged STUN/TURN port.
 *   - Else today's defaults exactly: 10100, 10101, 10102, 3478.
 *
 * Pure: env in, four numbers out, no process state. resolvePorts(process.env)
 * at each service's boot; the resolver never reads process.env itself so the
 * tests can drive it with a plain object. */

export type PortsEnv = Record<string, string | undefined>;

export type Ports = {
  APP_PORT: number;
  AGENT_PORT: number;
  VOICE_PORT: number;
  TURN_PORT: number;
};

/* Today's defaults, the ones every service carried inline before this file. */
const DEFAULTS: Ports = { APP_PORT: 10100, AGENT_PORT: 10101, VOICE_PORT: 10102, TURN_PORT: 3478 };

/* The offset each derived port sits at above CYC_PORT_BASE. */
const OFFSETS: Ports = { APP_PORT: 0, AGENT_PORT: 1, VOICE_PORT: 2, TURN_PORT: 3378 };

function finite(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function resolvePorts(env: PortsEnv): Ports {
  const base = finite(env.CYC_PORT_BASE);
  const pick = (name: keyof Ports): number => {
    const own = finite(env[name]);
    if (own !== null) return own; // an explicit port always wins
    if (base !== null) return base + OFFSETS[name];
    return DEFAULTS[name];
  };
  return {
    APP_PORT: pick("APP_PORT"),
    AGENT_PORT: pick("AGENT_PORT"),
    VOICE_PORT: pick("VOICE_PORT"),
    TURN_PORT: pick("TURN_PORT"),
  };
}
