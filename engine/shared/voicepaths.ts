/* Where the sherpa-onnx voice models live on this host: ONE resolver used by
 * both the agent engine (voicemodels.ts downloads into it, services.ts gates
 * on it) and the voice engine (sherpa.ts loads from it), so the two can never
 * name different directories.
 *
 * The layout inside is sherpa-onnx's own: one directory per model, exactly as
 * the upstream tarballs/repos ship them:
 *
 *   <models>/kokoro-multi-lang-v1_0/        model.onnx, voices.bin, tokens.txt,
 *                                           espeak-ng-data/, dict/, lexicon-*.txt
 *   <models>/sherpa-onnx-whisper-<size>/    <size>-encoder.int8.onnx,
 *                                           <size>-decoder.int8.onnx,
 *                                           <size>-tokens.txt
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The models root. CYC_MODELS_DIR overrides (tests, relocations); otherwise
 *  macOS Application Support, else XDG data home. */
export function voiceModelsDir(): string {
  const env = process.env.CYC_MODELS_DIR;
  if (env && env.length > 0) return env;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "cyc", "models");
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "cyc", "models");
}

/** A kokoro variant's directory name, exactly as its tarball extracts. */
export function kokoroDirName(variant: string): string {
  return `kokoro-${variant}`;
}

/** A whisper size's directory name, exactly as csukuangfj's HF repos name it. */
export function whisperDirName(size: string): string {
  return `sherpa-onnx-whisper-${size}`;
}

/** The files a kokoro variant needs on disk to load (the gate paths). The
 *  espeak-ng-data and dict directories ride in the same tarball, so these
 *  three being present means the extraction completed. */
export function kokoroPresencePaths(variant: string, dir = voiceModelsDir()): string[] {
  const d = join(dir, kokoroDirName(variant));
  return [join(d, "model.onnx"), join(d, "voices.bin"), join(d, "tokens.txt")];
}

/** The files a whisper size needs on disk to load (the gate paths). int8
 *  quantised: the fp weights of the large models exceed onnx's 2GB protobuf
 *  bound and ship as external-data files; int8 is one self-contained file per
 *  net and is what sherpa's own examples load. */
export function whisperPresencePaths(size: string, dir = voiceModelsDir()): string[] {
  const d = join(dir, whisperDirName(size));
  return [
    join(d, `${size}-encoder.int8.onnx`),
    join(d, `${size}-decoder.int8.onnx`),
    join(d, `${size}-tokens.txt`),
  ];
}
