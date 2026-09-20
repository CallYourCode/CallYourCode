type CycCallResult = {ok: boolean; result?: unknown; message?: string};

type CycGlobal = {
  call(op: string, args: unknown): Promise<CycCallResult>;

  save(state: unknown): Promise<{ok: boolean; message: string}>;
  load(): Promise<{ok: boolean; saved: boolean; data: unknown; message: string}>;
  close(): void;
};

export function cyc(): CycGlobal {
  return (window as unknown as {cyc: CycGlobal}).cyc;
}

export function readMs(): number {
  try {
    const v = Number(
      getComputedStyle(document.documentElement).getPropertyValue('--cyc-read-ms').trim()
    );
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  const o = Number((window as unknown as {__cycReadMs?: unknown}).__cycReadMs);
  return Number.isFinite(o) && o > 0 ? o : 20_000;
}

export async function callRead<T>(
  op: string,
  args: Record<string, string>,
  ms: number,
  signal?: AbortSignal
): Promise<T | {ok: false; error: string}> {
  const c = cyc();
  if (!c) return {ok: false, error: 'the engine is unreachable'};
  const deadline = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), ms));
  let r: CycCallResult | 'timeout';
  try {
    r = await Promise.race([c.call(op, args), deadline]);
  } catch {
    return {ok: false, error: 'the engine is unreachable'};
  }
  if (signal?.aborted) return {ok: false, error: 'aborted'};
  if (r === 'timeout') return {ok: false, error: 'the engine did not answer in time'};
  if (!r.ok) {
    const msg = String(r.message ?? '');
    if (/tim(e|ed) out/i.test(msg)) return {ok: false, error: 'the engine did not answer in time'};
    return {ok: false, error: msg || 'the engine is unreachable'};
  }
  return r.result as T;
}
