import type {SttStream, SttStreamHandlers} from './contract';
import {b64encode} from '@shared/e2e';

const STT_FINAL_TIMEOUT_MS = 15_000;

// The live stream is throughput-bounded, not memory-bounded: while the sealed
// pipe is above its low-water mark we QUEUE audio in order rather than dropping
// it, then coalesce and send the backlog the moment the pipe drains. The queue
// is capped at STT_QUEUE_MAX_S of audio; past that the OLDEST is dropped (with a
// counter), because the batch fallback re-decodes the whole clip anyway, so the
// only cost of an overflow is a gap in the LIVE words, never in the final.
const STT_RATE = 16000;
const STT_QUEUE_MAX_S = 30;
const STT_QUEUE_MAX_SAMPLES = STT_QUEUE_MAX_S * STT_RATE;

export type DcSttDeps = {
  send: (frame: object) => boolean;

  drain: () => Promise<void>;

  detach: (id: string) => void;
};

export class DcSttStream implements SttStream {
  public failed = false;

  // Live-stream accounting, read on capture.clip so the owner's own recordings
  // show what actually reached the engine vs. what the bound had to drop.
  public sentChunks = 0;
  public sentSamples = 0;
  public droppedChunks = 0;
  public droppedSamples = 0;

  public readonly id: string = crypto.randomUUID();

  private stopped = false;
  private settled = false;

  private draining = false;
  // Audio produced while the pipe is above its low-water mark, in order. It is
  // flushed (coalesced into one frame) as soon as the pipe drains.
  private queue: Float32Array[] = [];
  private queuedSamples = 0;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveFinal!: (text: string) => void;
  private rejectFinal!: (err: Error) => void;
  private readonly finalPromise: Promise<string>;

  constructor(
    private deps: DcSttDeps,
    private handlers: SttStreamHandlers
  ) {
    this.finalPromise = new Promise<string>((res, rej) => {
      this.resolveFinal = res;
      this.rejectFinal = rej;
    });

    this.finalPromise.catch(() => {});

    if (!this.deps.send({t: 'stt-open', id: this.id, rate: 16000, format: 'f32'})) {
      this.fail(new Error('stt-stream: engine pipe not sealed'));
    }
  }

  push(pcm: Float32Array): void {
    if (this.settled || this.stopped) return;
    this.enqueue(pcm);
    this.pump();
  }

  // Append audio in order, holding the queue to STT_QUEUE_MAX_SAMPLES by dropping
  // the OLDEST past the bound. Never drops the chunk just pushed.
  private enqueue(pcm: Float32Array): void {
    this.queue.push(pcm);
    this.queuedSamples += pcm.length;
    while (this.queuedSamples > STT_QUEUE_MAX_SAMPLES && this.queue.length > 1) {
      const old = this.queue.shift()!;
      this.queuedSamples -= old.length;
      this.droppedChunks++;
      this.droppedSamples += old.length;
    }
  }

  // Coalesce the whole queue into one frame and send it, then park on the pipe's
  // drain; when it resolves, send whatever queued in the meantime. One frame in
  // flight at a time, so the sealed pipe's backpressure still paces us -- we just
  // no longer throw audio away while it applies.
  private pump(): void {
    if (this.draining || this.settled || this.stopped) return;
    if (!this.queue.length) return;
    if (!this.sendQueued()) return;
    this.draining = true;
    this.deps.drain().then(
      () => {
        this.draining = false;
        this.pump();
      },
      () => {
        this.draining = false;
        this.pump();
      }
    );
  }

  // Drain the queue into a single coalesced stt-b frame. Returns false (and fails
  // the stream) if the pipe rejects the write; true when there was nothing to
  // send or the send succeeded.
  private sendQueued(): boolean {
    if (!this.queue.length) return true;
    const chunks = this.queue;
    const samples = this.queuedSamples;
    this.queue = [];
    this.queuedSamples = 0;

    const merged = chunks.length === 1 ? chunks[0] : mergeF32(chunks, samples);
    const bytes = new Uint8Array(merged.buffer as ArrayBuffer, merged.byteOffset, merged.byteLength);
    if (!this.deps.send({t: 'stt-b', id: this.id, b: b64encode(bytes)})) {
      this.fail(new Error('stt-stream: engine pipe closed'));
      return false;
    }
    this.sentChunks += chunks.length;
    this.sentSamples += samples;
    return true;
  }

  finish(): Promise<string> {
    if (!this.stopped && !this.settled) {
      this.stopped = true;

      // Deliver the tail before closing so the streamed final decodes over ALL
      // the audio that reached the queue, not just what a drain window let out.
      this.sendQueued();
      this.deps.send({t: 'stt-close', id: this.id});
      this.finalTimer = setTimeout(
        () => this.fail(new Error('stt-stream: no final within timeout')),
        STT_FINAL_TIMEOUT_MS
      );
    }
    return this.finalPromise;
  }

  abort(): void {
    if (!this.settled) this.deps.send({t: 'stt-close', id: this.id});
    this.fail(new Error('stt-stream: aborted'));
  }

  onFrame(frame: {
    t?: unknown;
    text?: unknown;
    committed?: unknown;
    committedS?: unknown;
    error?: unknown;
  }): void {
    switch (frame?.t) {
      case 'stt-partial':
        if (!this.settled) {
          this.handlers.onPartial?.(
            String(frame.text ?? ''),
            Number.isFinite(frame.committed) ? Number(frame.committed) : undefined,
            Number.isFinite(frame.committedS) ? Number(frame.committedS) : undefined
          );
        }
        break;
      case 'stt-final':
        this.settle(String(frame.text ?? ''));
        break;
      case 'stt-error':
        this.fail(new Error('stt-stream: ' + String(frame.error ?? 'engine error')));
        break;
    }
  }

  onClosed(): void {
    this.fail(new Error('stt-stream: closed before final'));
  }

  private settle(text: string): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.resolveFinal(text);
  }

  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.failed = true;
    this.cleanup();
    this.rejectFinal(err);
  }

  private cleanup(): void {
    this.queue = [];
    this.queuedSamples = 0;
    if (this.finalTimer !== null) {
      clearTimeout(this.finalTimer);
      this.finalTimer = null;
    }
    this.deps.detach(this.id);
  }
}

function mergeF32(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
