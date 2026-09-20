export const STT_RATE = 16000;
const STT_CHUNK_MS = 250;
const STT_CHUNK_SAMPLES = Math.round((STT_RATE * STT_CHUNK_MS) / 1000);

export class Pcm16kChunker {
  private readonly ratio: number;
  private prev = 0;
  private hasPrev = false;
  private frac = 0;
  private chunk = new Float32Array(STT_CHUNK_SAMPLES);
  private n = 0;

  constructor(
    inRate: number,
    private onChunk: (pcm: Float32Array) => void
  ) {
    if (!(inRate > 0)) throw new Error(`Pcm16kChunker: bad rate ${inRate}`);
    this.ratio = inRate / STT_RATE;
  }

  push(input: Float32Array): void {
    if (!input.length) return;

    let buf: Float32Array;
    if (this.hasPrev) {
      buf = new Float32Array(input.length + 1);
      buf[0] = this.prev;
      buf.set(input, 1);
    } else {
      buf = input;
    }
    const last = buf.length - 1;
    let p = this.frac;
    while (p <= last) {
      const i = Math.floor(p);
      const s = i >= last ? buf[last] : buf[i] + (buf[i + 1] - buf[i]) * (p - i);
      this.chunk[this.n++] = s;
      if (this.n === this.chunk.length) {
        this.onChunk(this.chunk);
        this.chunk = new Float32Array(STT_CHUNK_SAMPLES);
        this.n = 0;
      }
      p += this.ratio;
    }
    this.prev = buf[last];
    this.hasPrev = true;
    this.frac = p - last;
  }

  flush(): void {
    if (!this.n) return;
    this.onChunk(this.chunk.slice(0, this.n));
    this.chunk = new Float32Array(STT_CHUNK_SAMPLES);
    this.n = 0;
  }
}

export const PCM_TAP_PROCESSOR_NAME = 'cyc-pcm-tap';

export const PCM_TAP_WORKLET_JS = `
class CycPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if(ch) {
      let i = 0;
      while(i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if(this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${PCM_TAP_PROCESSOR_NAME}', CycPcmTap);
`;
