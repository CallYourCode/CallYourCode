/* Three local services, explicit ports override the base and stable offsets. */
export type PortsEnv = Record<string, string | undefined>;

export type Ports = {
  APP_PORT: number;
  AGENT_PORT: number;
  VOICE_PORT: number;
};

/* Today's defaults, the ones every service carried inline before this file. */
const DEFAULTS: Ports = { APP_PORT: 10100, AGENT_PORT: 10101, VOICE_PORT: 10102 };

/* The offset each derived port sits at above CYC_PORT_BASE. */
const OFFSETS: Ports = { APP_PORT: 0, AGENT_PORT: 1, VOICE_PORT: 2 };

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
  };
}
