import {isTransientStatus} from '../sync/drain';
import {engineFetch} from './engineFetch';

// One HTTP write for an intent, sorted into the drain's vocabulary: an answer
// that is not the engine's (offline, a timeout, 5xx, 408, 429) is transient
// and the intent stays queued; any other refusal is the engine's last word.
export type IntentHttp =
  | {ok: true; status: number; json: Record<string, unknown>}
  | {ok: false; outcome: 'transient' | {failed: string}};

export async function postIntent(
  engineKey: string,
  path: string,
  body: unknown,
  timeoutMs = 8000
): Promise<IntentHttp> {
  let res: Response;
  try {
    res = await engineFetch(engineKey, path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
      timeoutMs
    });
  } catch {
    return {ok: false, outcome: 'transient'};
  }
  if (res.ok) {
    const json = (await res.json().catch(() => ({}))) as unknown;
    return {ok: true, status: res.status, json: json && typeof json === 'object' ? (json as Record<string, unknown>) : {}};
  }
  if (isTransientStatus(res.status)) return {ok: false, outcome: 'transient'};
  const said = await res
    .json()
    .then((j: {error?: unknown}) => (typeof j?.error === 'string' ? j.error : ''))
    .catch(() => '');
  return {ok: false, outcome: {failed: said || `the engine refused it (HTTP ${res.status})`}};
}
