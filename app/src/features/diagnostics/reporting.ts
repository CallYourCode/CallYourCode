import {cyclog, logTail, logIdentity, logShipState} from '@/shared/logging';
import {appFetch} from '../../engine/appFetch';

const TAIL_LINES = 400;

const TEXT_MAX = 2000;

const OUTBOX_MAX = 20;

const CID_MAX = 5;

const SEND_MS = 10_000;

const RETRY_MS = 60_000;

const OUTBOX_KEY = 'cyc-bug-outbox';

type BugReport = {
  ref: string;

  at: string;
  text: string;
  device: string;
  page: string;

  build: string;
  ua: string;
  screen: string;

  session: {id: string; title: string} | null;

  engine: {state: string; key: string | null};

  ship: {queued: number; dropped: number; failures: number};

  cids: string[];
  lines: string[];
};

type ReportContext = {
  session: {id: string; title: string} | null;
  engine: {state: string; key: string | null};
  build: string;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function newRef(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function cidsIn(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < CID_MAX; i--) {
    for (const m of lines[i].matchAll(/\bcid=([A-Za-z0-9_.-]{1,64})/g)) {
      if (!out.includes(m[1])) out.push(m[1]);
      if (out.length >= CID_MAX) break;
    }
  }
  return out;
}

export function gather(text: string, ctx: ReportContext): BugReport {
  const lines = logTail(TAIL_LINES);
  const id = logIdentity();
  return {
    ref: newRef(),
    at: new Date().toISOString(),
    text: clip(text.trim(), TEXT_MAX),
    device: id.device,
    page: id.page,
    build: clip(ctx.build, 200),
    ua: clip(typeof navigator === 'undefined' ? '' : navigator.userAgent, 300),
    screen:
      typeof window === 'undefined'
        ? ''
        : `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`,
    session: ctx.session,
    engine: ctx.engine,
    ship: logShipState(),
    cids: cidsIn(lines),
    lines
  };
}

function readOutbox(): BugReport[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    const j = raw ? JSON.parse(raw) : null;
    return Array.isArray(j) ? (j as BugReport[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(list: BugReport[]): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-OUTBOX_MAX)));
  } catch {}
}

export function waitingReports(): number {
  return readOutbox().length;
}

async function post(r: BugReport): Promise<string | null> {
  try {
    const res = await appFetch('/report', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(r),
      signal: AbortSignal.timeout(SEND_MS)
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {ok?: boolean; id?: unknown};
    return j?.ok === true && typeof j.id === 'string' && j.id ? j.id : null;
  } catch {
    return null;
  }
}

type FileResult = {state: 'sent'; id: string} | {state: 'waiting'; waiting: number};

export async function fileReport(text: string, ctx: ReportContext): Promise<FileResult> {
  const r = gather(text, ctx);
  const held = readOutbox();
  held.push(r);
  writeOutbox(held);
  cyclog('bug.report.filed', {
    ref: r.ref,
    chars: r.text.length,
    lines: r.lines.length,
    cids: r.cids.join(','),
    held: readOutbox().length
  });

  const id = await post(r);
  if (!id) {
    const waiting = readOutbox().length;
    cyclog('bug.report.waiting', {
      ref: r.ref,
      waiting,
      why: 'the app server did not answer with an id, so it is on this device only'
    });
    return {state: 'waiting', waiting};
  }
  writeOutbox(readOutbox().filter((x) => x.ref !== r.ref));
  cyclog('bug.report.sent', {ref: r.ref, id, held: readOutbox().length});
  return {state: 'sent', id};
}

async function flushReports(): Promise<number> {
  let held = readOutbox();
  if (!held.length) return 0;
  let sent = 0;
  for (const r of held) {
    const id = await post(r);
    if (!id) break;
    sent++;
    writeOutbox(readOutbox().filter((x) => x.ref !== r.ref));
    cyclog('bug.report.sent', {ref: r.ref, id, late: 1});
  }
  held = readOutbox();
  if (sent) cyclog('bug.report.flushed', {sent, waiting: held.length});
  return held.length;
}

let outboxStarted = false;
export function startReportOutbox(onChange: () => void = () => {}): void {
  if (outboxStarted || typeof document === 'undefined') return;
  outboxStarted = true;
  const go = (): void => {
    void flushReports().then(onChange);
  };
  go();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') go();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && waitingReports()) go();
  }, RETRY_MS);
}
