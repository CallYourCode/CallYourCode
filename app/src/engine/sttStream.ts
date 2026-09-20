import type {SttStream, SttStreamHandlers} from './contract';
import {b64encode} from '@shared/e2e';

const STT_FINAL_TIMEOUT_MS = 15_000;

export type DcSttDeps = {
  send: (frame: object) => boolean;

  drain: () => Promise<void>;

  detach: (id: string) => void;
};

export class DcSttStream implements SttStream {
  public failed = false;
  public dropped = 0;

  public readonly id: string = crypto.randomUUID();

  private stopped = false;
  private settled = false;

  private draining = false;
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
    if (this.draining) {
      this.dropped++;
      return;
    }

    const bytes = new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength);
    if (!this.deps.send({t: 'stt-b', id: this.id, b: b64encode(bytes)})) {
      this.fail(new Error('stt-stream: engine pipe closed'));
      return;
    }
    this.draining = true;
    this.deps.drain().then(
      () => {
        this.draining = false;
      },
      () => {
        this.draining = false;
      }
    );
  }

  finish(): Promise<string> {
    if (!this.stopped && !this.settled) {
      this.stopped = true;

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
    if (this.finalTimer !== null) {
      clearTimeout(this.finalTimer);
      this.finalTimer = null;
    }
    this.deps.detach(this.id);
  }
}
