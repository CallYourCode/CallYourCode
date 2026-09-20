import {restartClaim, type RestartClaim} from '../restartClaim';

import type {FsFail} from '../fsFail';
import type {CycEngineSession} from './types';
import {markedUnread, notify, sessions} from './registry';
import {persistRoster} from './roster';
import {engineFetch} from './engineFetch';
import {postIntent} from './intentHttp';
import * as intents from '../intents';
import type {Intent, RenamePayload, ReorderPayload, UnreadPayload} from '../intents';
import * as drain from '../sync/drain';
import type {DrainOutcome} from '../sync/drain';

type SessionOpsDeps = {
  list(): CycEngineSession[];
};
let deps: SessionOpsDeps | null = null;
export function wireSessionOps(d: SessionOpsDeps): void {
  deps = d;
}

// Rename, reorder and mark-unread are intents (offline design v2, section 3):
// applied to the local row at once, persisted in the roster, and taken to the
// engine by the drain in order. The promise each returns settles when the
// engine has taken the intent (true) or refused it for good (false); a reload
// before that leaves the row queued and the promise gone, which is fine, the
// row drains on its own.

function newId(coalesceKey: string): string {
  return coalesceKey + ':' + (crypto.randomUUID?.() ?? Date.now().toString(36));
}

function sessionOf(engineKey: string, paneId: string): CycEngineSession | undefined {
  return sessions.get(engineKey + '|' + paneId);
}

export function reorderSessions(sessionIds: string[]): Promise<boolean> {
  const rows = sessionIds.map((id) => sessions.get(id)).filter((s) => !!s);
  const engineKey = rows[0]?.engineKey;
  if (!engineKey) return Promise.resolve(false);
  const moved = rows.filter((s) => s.engineKey === engineKey);
  const movedIds = new Set(moved.map((s) => s.id));
  const queue = moved.map((s) => s.paneId);
  const engineRows = (deps?.list() ?? []).filter((s) => s.engineKey === engineKey);
  const order = engineRows.map((s) => (movedIds.has(s.id) ? queue.shift()! : s.paneId));
  const before: Record<string, number | undefined> = {};
  for (const s of engineRows) before[s.paneId] = s.order;
  order.forEach((paneId, i) => {
    const s = sessionOf(engineKey, paneId);
    if (s) s.order = i;
  });
  persistRoster(engineKey);
  notify();
  const row = intents.put({
    id: newId('reorder:' + engineKey),
    engineKey,
    kind: 'reorder',
    coalesceKey: 'reorder:' + engineKey,
    payload: {order, before} satisfies ReorderPayload
  });
  drain.kick(engineKey);
  return drain.whenSettled(row.id);
}

drain.registerExecutor('reorder', async (intent: Intent): Promise<DrainOutcome> => {
  const p = intent.payload as ReorderPayload;
  const res = await postIntent(intent.engineKey, '/sessions/order', {order: p.order});
  if (res.ok === true) return 'done';
  if (res.outcome !== 'transient') {
    for (const [paneId, order] of Object.entries(p.before)) {
      const s = sessionOf(intent.engineKey, paneId);
      if (!s) continue;
      if (order === undefined) delete s.order;
      else s.order = order;
    }
    persistRoster(intent.engineKey);
    notify();
  }
  return res.outcome;
});

export function renameSession(sessionId: string, name: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return Promise.resolve(false);
  const before = {name: s.name, title: s.title?.text ?? null};
  applyName(s, name);
  persistRoster(s.engineKey);
  notify();
  const row = intents.put({
    id: newId('rename:' + sessionId),
    engineKey: s.engineKey,
    sessionId,
    kind: 'rename',
    coalesceKey: 'rename:' + sessionId,
    payload: {paneId: s.paneId, name, before} satisfies RenamePayload
  });
  drain.kick(s.engineKey);
  return drain.whenSettled(row.id);
}

// The list row reads `title.text` when the engine sends a title (chatRow.ts),
// so the local apply of a rename paints the title too, exactly as the engine's
// next sessions frame will (its title resolves the rename override first).
function applyName(s: CycEngineSession, name: string): void {
  s.name = name;
  if (s.title) s.title = {...s.title, text: name};
}

drain.registerExecutor('rename', async (intent: Intent): Promise<DrainOutcome> => {
  const p = intent.payload as RenamePayload;
  const res = await postIntent(
    intent.engineKey,
    '/session/' + encodeURIComponent(p.paneId) + '/rename',
    {name: p.name}
  );
  if (res.ok === true) return 'done';
  if (res.outcome !== 'transient') {
    const s = sessionOf(intent.engineKey, p.paneId);
    if (s && s.name === p.name) {
      s.name = p.before.name;
      if (s.title && p.before.title !== null) s.title = {...s.title, text: p.before.title};
      persistRoster(intent.engineKey);
      notify();
    }
  }
  return res.outcome;
});

export function setSessionUnread(sessionId: string, unread: boolean): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return Promise.resolve(false);

  /* Optimistic, offline-first: paint the row and persist the roster NOW, before
   * the round-trip, so the badge appears (or lifts) the instant he taps it. The
   * engine owns the marker; this mirrors what it is about to say. `markedUnread`
   * is what keeps the badge on the open chat's own row (handlers/sessions.ts). */
  const before = {unread: s.unread, marked: markedUnread.has(sessionId)};
  if (unread) {
    markedUnread.add(sessionId);
    if (s.unread < 1) s.unread = 1;
  } else {
    markedUnread.delete(sessionId);
    s.unread = 0;
  }
  persistRoster(s.engineKey);
  notify();
  const row = intents.put({
    id: newId('unread:' + sessionId),
    engineKey: s.engineKey,
    sessionId,
    kind: 'mark-unread',
    coalesceKey: 'unread:' + sessionId,
    payload: {paneId: s.paneId, unread, before} satisfies UnreadPayload
  });
  drain.kick(s.engineKey);
  return drain.whenSettled(row.id);
}

drain.registerExecutor('mark-unread', async (intent: Intent): Promise<DrainOutcome> => {
  const p = intent.payload as UnreadPayload;
  const s = sessionOf(intent.engineKey, p.paneId);
  const res = await postIntent(
    intent.engineKey,
    '/session/' + encodeURIComponent(p.paneId) + '/unread',
    {read: !p.unread}
  );
  if (res.ok === true) {
    // `ok:false` is not a failure: the engine says what the count is, and the
    // row adopts it (the frame may not have landed yet).
    if (s && typeof res.json.unread === 'number' && res.json.unread !== s.unread) {
      s.unread = res.json.unread;
      if (s.unread === 0) markedUnread.delete(s.id);
      persistRoster(intent.engineKey);
      notify();
    }
    return 'done';
  }
  if (res.outcome !== 'transient' && s) {
    s.unread = p.before.unread;
    if (p.before.marked) markedUnread.add(s.id);
    else markedUnread.delete(s.id);
    persistRoster(intent.engineKey);
    notify();
  }
  return res.outcome;
});

export async function exitSession(sessionId: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return false;
  try {
    const res = await engineFetch(
      s.engineKey,
      '/session/' + encodeURIComponent(s.paneId) + '/exit',
      {
        method: 'POST',
        timeoutMs: 8000
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function restartSession(sessionId: string): Promise<RestartClaim | null> {
  const s = sessions.get(sessionId);
  if (!s) return null;
  try {
    const res = await engineFetch(
      s.engineKey,
      '/session/' + encodeURIComponent(s.paneId) + '/restart',
      {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({mode: 'resume'}),

        timeoutMs: 60000
      }
    );

    return restartClaim(await res.json().catch((): null => null));
  } catch {
    return null;
  }
}

export type NewSessionPlaces = {
  places: string[];
  home: string | null;
  def: string | null;
  harnesses: Array<{kind: string; available: boolean}>;
  recent: string[];
};

export async function newSessionPlaces(engineKey: string): Promise<NewSessionPlaces | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await engineFetch(engineKey, '/new-session/places', {timeoutMs: 8000});
      if (res.ok) {
        const json = await res.json();
        return {
          places: Array.isArray(json?.places)
            ? json.places.filter((p: unknown) => typeof p === 'string')
            : [],
          home: typeof json?.home === 'string' && json.home ? json.home : null,
          def: typeof json?.def === 'string' && json.def ? json.def : null,
          // Both new fields parsed tolerantly: an older engine omits them, and any
          // malformed entry is dropped rather than trusted. Absent -> [].
          harnesses: Array.isArray(json?.harnesses)
            ? json.harnesses.filter(
                (h: unknown): h is {kind: string; available: boolean} =>
                  !!h &&
                  typeof (h as {kind?: unknown}).kind === 'string' &&
                  !!(h as {kind?: unknown}).kind &&
                  typeof (h as {available?: unknown}).available === 'boolean'
              )
            : [],
          recent: Array.isArray(json?.recent)
            ? json.recent.filter((p: unknown) => typeof p === 'string')
            : []
        };
      }
    } catch {}
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export type RecentlyClosed = {
  agentId: string;
  name: string;
  harness: string;
  cwd: string;
  canResume: boolean;
};

/* The + menu's "Recently closed" list: agents this engine owns whose pane is
 * gone but whose identity survives on disk. Best-effort: any failure (an older
 * engine with no route, an unreachable engine, a malformed body) answers [] so
 * the section is simply skipped, never a toast. */
export async function recentlyClosed(engineKey: string): Promise<RecentlyClosed[]> {
  try {
    const res = await engineFetch(engineKey, '/agents/recently-closed', {timeoutMs: 8000});
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.filter(
      (r: unknown): r is RecentlyClosed =>
        !!r &&
        typeof (r as {agentId?: unknown}).agentId === 'string' &&
        !!(r as {agentId?: unknown}).agentId &&
        typeof (r as {harness?: unknown}).harness === 'string' &&
        typeof (r as {cwd?: unknown}).cwd === 'string'
    );
  } catch {
    return [];
  }
}

export type StartedSession = {paneId: string; agentId: string; why: string};

export async function startSession(
  engineKey: string,
  cwd: string,
  near?: string,
  harness?: string,
  reopen?: {agentId: string; resume: boolean}
): Promise<StartedSession> {
  let res: Response;
  try {
    res = await engineFetch(engineKey, '/new-session', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      // Send `harness` only when chosen, and the reopen fields only when a
      // recently-closed agent is being reopened, so an old engine never sees an
      // unknown field for an ordinary new session.
      body: JSON.stringify(
        reopen
          ? {cwd, near, agentId: reopen.agentId, resume: reopen.resume}
          : harness
            ? {cwd, near, harness}
            : {cwd, near}
      ),
      timeoutMs: 20000
    });
  } catch (e) {
    return {
      paneId: '',
      agentId: '',
      why:
        (e as Error)?.name === 'TimeoutError'
          ? 'the engine did not answer within 20s'
          : 'could not reach the engine'
    };
  }
  const json = (await res.json().catch((): null => null)) as {
    paneId?: unknown;
    agentId?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok) {
    return {
      paneId: '',
      agentId: '',
      why:
        typeof json?.error === 'string' && json.error
          ? json.error
          : `the engine answered ${res.status}`
    };
  }
  if (typeof json?.paneId !== 'string' || !json.paneId) {
    return {paneId: '', agentId: '', why: 'the engine said yes but named no pane'};
  }
  const agentId = typeof json?.agentId === 'string' ? json.agentId : '';
  return {paneId: json.paneId, agentId, why: ''};
}

export async function setSessionPhoto(
  sessionId: string,
  photo: Blob | null
): Promise<{ok: true} | FsFail> {
  const s = sessions.get(sessionId);
  if (!s) return {ok: false, error: 'that session is not on any engine any more'};
  try {
    const res = await engineFetch(
      s.engineKey,
      '/session/' + encodeURIComponent(s.paneId) + '/photo',
      {
        method: 'POST',

        headers: photo ? {'content-type': photo.type} : {},
        body: photo ?? '',

        timeoutMs: 60_000
      }
    );
    if (res.ok) return {ok: true};
    const said = await res
      .json()
      .then((j: {error?: unknown}) => (typeof j?.error === 'string' ? j.error : ''))
      .catch(() => '');
    return {ok: false, error: said || `the engine refused it (HTTP ${res.status})`};
  } catch (e) {
    return {
      ok: false,
      error:
        (e as Error)?.name === 'TimeoutError'
          ? 'the engine did not answer in time'
          : 'the engine is unreachable'
    };
  }
}
