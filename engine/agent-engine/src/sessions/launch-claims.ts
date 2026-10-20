/* Shared by app reopen and boot recovery. Reserve BOTH identities before the
 * first await that can launch, including the announce gap after spawn. */
import { sessions } from "./session-state.ts";
import { hookAnnouncedAfter } from "../terminal/hook-announce.ts";
const claims = new Map<string, symbol>();
export function resetLaunchClaimsForTest(): void { claims.clear(); }
export function claimLaunch(agentId: string, sessionId: string | null): (() => void) | null {
  const keys = [agentId, ...(sessionId ? [`session:${sessionId}`] : [])];
  if (keys.some((k) => claims.has(k))) return null;
  const owner = Symbol(agentId);
  keys.forEach((k) => claims.set(k, owner));
  return () => keys.forEach((k) => { if (claims.get(k) === owner) claims.delete(k); });
}
export async function waitForLaunch(agentId: string, sessionId: string | null, handle: string, timeoutMs = 60_000, announcedAfter?: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  do {
    const s = sessions.get(agentId);
    if (s?.alive && s.muxHandle === handle && (!sessionId || s.harnessSessionId === sessionId) &&
        (announcedAfter === undefined || (!!sessionId && hookAnnouncedAfter(handle, sessionId, announcedAfter)))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 200).unref());
  } while (Date.now() < until);
  throw new Error("agent was not detected on its exact session before the 60s deadline");
}
