/* Which voice engine should this request use?
 *
 * There can be several: one per machine, each with its own hardware. They all
 * publish /health with what they can do and how fast they have been doing it,
 * so the choice is a measurement rather than a guess.
 *
 * It lives here because it is one decision, made once. It used to be two: the
 * agent engine picked a TTS endpoint by "first one that answers", while the
 * BROWSER was separately told where to stream its microphone, by whichever
 * engine it happened to attach to. Neither knew what the other had chosen, and
 * neither knew which was busy.
 *
 * What /health gives us:
 *   stream.up, batch.up, tts.up      can it do the job at all
 *   *.rtf                            realtime factor, lower is faster
 *   stream.active_streams            how busy it is right now
 *
 * The rule: among the engines that can do the job, prefer the idle one; among
 * equally idle ones, the fastest. A machine that is already transcribing two
 * streams is a worse choice than a slower machine doing nothing, because
 * queueing behind someone else costs more than the speed difference.
 */

export type VoiceRole = "stream" | "batch" | "tts";

export type VoiceEngine = {
  url: string;          // reachable from the SERVER
  publicUrl: string;    // reachable from a BROWSER (tailnet, later the relay)
  label: string;
  up: boolean;
  can: Record<VoiceRole, boolean>;
  rtf: Partial<Record<VoiceRole, number | null>>;
  load: number;         // active streams
  checkedAt: number;
  error?: string;
};

const HEALTH_TTL_MS = 15_000;   // health is cheap, but not per-request cheap
const HEALTH_TIMEOUT_MS = 2500;

export class VoicePool {
  private engines: VoiceEngine[];
  private checking: Promise<void> | null = null;

  /* Configured as "url" or "url|publicUrl|label", comma separated. */
  constructor(spec: string) {
    this.engines = spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const [url, publicUrl, label] = entry.split("|").map((p) => p?.trim() ?? "");
        return {
          url: url.replace(/\/$/, ""),
          publicUrl: (publicUrl || url).replace(/\/$/, ""),
          label: label || new URL(url).hostname,
          up: false,
          can: { stream: false, batch: false, tts: false },
          rtf: {},
          load: 0,
          checkedAt: 0,
        };
      });
  }

  list() {
    return this.engines;
  }

  private async checkOne(e: VoiceEngine) {
    try {
      const res = await fetch(`${e.url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const h = (await res.json()) as any;
      const c = h?.capabilities ?? {};
      e.up = h?.ok !== false;
      e.can = {
        stream: !!c.stream?.up,
        batch: !!c.batch?.up,
        tts: !!c.tts?.up,
      };
      e.rtf = {
        stream: typeof c.stream?.rtf === "number" ? c.stream.rtf : null,
        batch: typeof c.batch?.rtf === "number" ? c.batch.rtf : null,
        tts: typeof c.tts?.rtf === "number" ? c.tts.rtf : null,
      };
      e.load = Number(c.stream?.active_streams ?? h?.load?.active_streams ?? 0) || 0;
      e.error = undefined;
    } catch (err) {
      e.up = false;
      e.can = { stream: false, batch: false, tts: false };
      e.error = (err as Error)?.message ?? "unreachable";
    }
    e.checkedAt = Date.now();
  }

  /* Refresh anything stale. Concurrent callers share one sweep. */
  async refresh(force = false): Promise<void> {
    const stale = this.engines.filter((e) => force || Date.now() - e.checkedAt > HEALTH_TTL_MS);
    if (!stale.length) return;
    if (this.checking) return this.checking;
    this.checking = Promise.all(stale.map((e) => this.checkOne(e))).then(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /* The best engine for a role, or null when nobody can do it. */
  async pick(role: VoiceRole): Promise<VoiceEngine | null> {
    await this.refresh();
    const able = this.engines.filter((e) => e.up && e.can[role]);
    if (!able.length) return null;
    return able.sort((a, b) => {
      // busy loses to idle, whatever the hardware: waiting behind another
      // stream costs more than the speed difference between machines
      if (a.load !== b.load) return a.load - b.load;
      const ra = a.rtf[role] ?? Number.POSITIVE_INFINITY;
      const rb = b.rtf[role] ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;      // measured speed, lower is faster
      return this.engines.indexOf(a) - this.engines.indexOf(b); // configured order
    })[0];
  }
}
