/* The sherpa-onnx worker: the ONE place the native addon is loaded and called.
 *
 * sherpa-onnx-node's calls are synchronous C++ (a whisper decode of a 30s
 * window can take seconds on CPU), so they must never run on the server's
 * event loop: a decode there would freeze /health, /tts and every live stream
 * at once. Each worker hosts ONE model (role "tts" or "asr") and answers a
 * tiny message protocol; the backend (sherpa.ts) owns the workers and queues.
 *
 *   in : {t:"init", role, ...model paths...}
 *   out: {t:"ready", numSpeakers?, sampleRate?} | {t:"init-error", error}
 *   in : {t:"tts", id, text, sid, speed}
 *   out: {t:"done", id, samples: Float32Array, sampleRate} (buffer transferred)
 *   in : {t:"asr", id, samples: Float32Array, sampleRate}
 *   out: {t:"done", id, text} | {t:"done", id, error}
 *
 * Requests are answered in arrival order; the backend enforces any deadline.
 */

type WorkerScope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

const worker = globalThis as unknown as WorkerScope;

type InitMsg = {
  t: "init";
  role: "tts" | "asr";
  numThreads: number;
  kokoro?: { dir: string };
  whisper?: { dir: string; size: string; language: string };
};

let tts: any = null;
let recognizer: any = null;
let sherpa: any = null;

function init(m: InitMsg): void {
  try {
    sherpa = require("sherpa-onnx-node");
    if (m.role === "tts") {
      const d = m.kokoro!.dir;
      tts = new sherpa.OfflineTts({
        model: {
          kokoro: {
            model: `${d}/model.onnx`,
            voices: `${d}/voices.bin`,
            tokens: `${d}/tokens.txt`,
            dataDir: `${d}/espeak-ng-data`,
            dictDir: `${d}/dict`,
            lexicon: `${d}/lexicon-us-en.txt,${d}/lexicon-zh.txt`,
          },
          numThreads: m.numThreads,
          debug: 0,
        },
      });
      worker.postMessage({ t: "ready", numSpeakers: tts.numSpeakers, sampleRate: tts.sampleRate });
    } else {
      const { dir, size, language } = m.whisper!;
      recognizer = new sherpa.OfflineRecognizer({
        modelConfig: {
          whisper: {
            encoder: `${dir}/${size}-encoder.int8.onnx`,
            decoder: `${dir}/${size}-decoder.int8.onnx`,
            language,
            task: "transcribe",
          },
          tokens: `${dir}/${size}-tokens.txt`,
          numThreads: m.numThreads,
          debug: 0,
        },
      });
      worker.postMessage({ t: "ready" });
    }
  } catch (e) {
    worker.postMessage({ t: "init-error", error: String(e) });
  }
}

worker.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m?.t === "init") return init(m as InitMsg);
  if (m?.t === "tts") {
    try {
      const g = tts.generate({ text: m.text, sid: m.sid, speed: m.speed });
      const samples: Float32Array = g.samples instanceof Float32Array
        ? g.samples
        : Float32Array.from(g.samples);
      worker.postMessage({ t: "done", id: m.id, samples, sampleRate: g.sampleRate },
        [samples.buffer as ArrayBuffer]);
    } catch (e) {
      worker.postMessage({ t: "done", id: m.id, error: String(e) });
    }
    return;
  }
  if (m?.t === "asr") {
    try {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: m.samples, sampleRate: m.sampleRate });
      recognizer.decode(stream);
      const text = String(recognizer.getResult(stream).text ?? "");
      worker.postMessage({ t: "done", id: m.id, text });
    } catch (e) {
      worker.postMessage({ t: "done", id: m.id, error: String(e) });
    }
  }
};
