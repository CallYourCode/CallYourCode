import {cyclog} from '@/shared/logging';

// A field exception used to vanish: the tab kept running (or froze) while the
// only trace was a console line no one could read off a phone. This routes any
// uncaught error and unhandled promise rejection into the app log as
// `app.error`, so a crash names itself in app.log the way every other event
// does. Per-page dedupe cap: the same error (by message + source) is logged at
// most REPEAT_CAP times, so a handler that throws on every animation frame
// cannot drown the ring buffer.

const REPEAT_CAP = 5;
const STACK_MAX = 400;
const seen = new Map<string, number>();

function stackOf(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as {stack?: unknown}).stack === 'string') {
    return (err as {stack: string}).stack.slice(0, STACK_MAX);
  }
  return '';
}

function report(message: string, stack: string, source: string): void {
  const key = `${source}\u0000${message}`;
  const count = seen.get(key) ?? 0;
  if (count >= REPEAT_CAP) return;
  seen.set(key, count + 1);
  cyclog('app.error', {
    message: message.slice(0, STACK_MAX),
    stack,
    source,
    ...(count + 1 === REPEAT_CAP ? {capped: true} : {})
  });
}

export function installErrorReporter(target: Window = window): void {
  target.addEventListener('error', (e: ErrorEvent) => {
    const err = e.error;
    const message = String(e.message || (err && (err as {message?: unknown}).message) || 'error');
    const where = e.filename ? `${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0}` : 'window';
    report(message, stackOf(err), where);
  });

  target.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const message =
      reason && typeof reason === 'object' && 'message' in reason
        ? String((reason as {message: unknown}).message)
        : String(reason);
    report(message, stackOf(reason), 'unhandledrejection');
  });
}
