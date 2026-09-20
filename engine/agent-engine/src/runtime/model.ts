/* model.ts: the `cyc model` entrypoint.
 *
 * A thin CLI over voicemodels.ts. `whisper [size]` and `kokoro [variant]` show
 * the current voice model or, given an argument, set it: download it if
 * missing, persist the choice, and restart the voice engine. All the model
 * work lives in runModelCommand; this file only parses argv and adopts its
 * exit code. Anything else prints the usage line to stderr and exits 2.
 *
 * The old `stt [prebuilt|gpu]` backend picker is gone with the python stt
 * venv it rebuilt: the sherpa-onnx backend is prebuilt on every platform and
 * has no build-time choice to make.
 *
 *   bun run agent-engine/src/runtime/model.ts <whisper|kokoro> [size|variant]
 */

import { runModelCommand, WHISPER_KIND, KOKORO_KIND } from "../voice/voicemodels.ts";

if (import.meta.main) {
  const [sub, arg] = process.argv.slice(2);
  if (sub === "whisper") {
    process.exit(await runModelCommand(WHISPER_KIND, arg));
  } else if (sub === "kokoro") {
    process.exit(await runModelCommand(KOKORO_KIND, arg));
  } else {
    console.error("usage: cyc model <whisper|kokoro> [size|variant]");
    process.exit(2);
  }
}
