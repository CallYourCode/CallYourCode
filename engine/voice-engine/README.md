# voice-engine

The voice service listens on loopback port 10102. It owns the `/tts`, `/stt`,
`/stt-stream`, `/voices` and `/health` contract. `agent-engine` only reaches it
over HTTP and WebSocket.

Install and run from this directory:

```sh
bun install
bun run start
```

Run the checks with `bun run test` and `bun run typecheck`.

Source code is grouped by ownership:

- `src/server.ts` is the service boundary.
- `src/audio/` reads, writes and cuts PCM/WAV audio.
- `src/stt/` holds batch and stream transcript policy, vocabulary and STT tests.
- `src/backend/` hosts the shared Sherpa worker backend for STT and TTS.
- `src/tts/` owns TTS health checks.
- `public/test.html` is the loopback test bench.

There are no domain barrel files. Import the module that owns the behavior.
