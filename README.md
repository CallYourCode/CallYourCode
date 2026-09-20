<p align="center">
  <img src="docs/media/banner.png" alt="CallYourCode. Talk to your terminal coding sessions from a chat app." width="820">
</p>

**Talk to your own coding agents from your phone, in your own voice.**

Your agents already live in a terminal on your machine. CallYourCode (cyc)
puts every one of them in your pocket: each pane becomes a chat with a voice,
on a page you can open from anywhere. You speak, the words land in the pane as
ordinary terminal input, the agent works, and it speaks the result back.

No company server in the data path. No cloud speech API. No audio leaving your
machine. Your hardware, your network, your agents.

## The wow moment

Walk away from the desk. Your phone rings itself into a conversation: an agent
finishes a task and speaks the result. You answer out loud, "run the tests
again and tell me what broke," and the agent keeps going. The whole loop runs
on your own hardware over your own network.

<p align="center">
  <img src="docs/media/phone.png" alt="A conversation with a Claude Code agent on the phone: a spoken question, a written reply, and a voice note back." width="420">
</p>

## Why it is different

- **Private by construction.** The phone-to-machine link is a sealed,
  end-to-end encrypted WebRTC DataChannel. Chat text, voice audio, files,
  diffs: none of it touches a third party.
- **Voice without the cloud.** Speech is synthesized and transcribed
  in-process by sherpa-onnx (kokoro for text to speech, whisper for speech to
  text). No Python, no API key, no audio ever leaves your machine.
- **Your agents, unchanged.** Claude Code, Codex, OpenCode and Pi keep
  running where they always have, in tmux (or herdr) on your machine. cyc
  wires into them; it does not replace them.
- **Nothing between you and it.** Four Bun/TypeScript services and a PWA.
  Over your own tailnet, or plain localhost, there is no company server at
  all.

One roster, every agent on the machine: Claude Code, Codex, OpenCode and Pi,
each with its model, its crons, its git and files pages, and a TUI view.

<img src="docs/media/laptop.png" alt="The CallYourCode app on a laptop: a roster of Claude Code, Codex, OpenCode and Pi agents, one conversation open.">

And the same conversation, in the pane where the agent actually runs:

<p align="center">
  <img src="docs/media/terminal.png" alt="The same exchange inside the agent's tmux pane: the message arrives as terminal input, the agent replies through cyc." width="720">
</p>

## Get started in two minutes

One line installs everything: Bun if missing, the repo to `~/callyourcode`,
wiring for every agent it detects, and the services:

```sh
curl -fsSL https://callyourcode.com/install.sh | sh
```

Then link your phone and go:

```sh
cyc pair      # a Local/Cloud chooser, then a link (or QR) to open on your phone
cyc start     # start the services
```

Open an agent on your phone and say hello. The voice models (about 1 GB)
download in the background on first boot; each voice capability switches on
the moment its files land.

From a checkout already on disk: `sh scripts/install.sh --local`
(`--dry-run` touches nothing). Run `cyc help` for the full command set.

## What you need

- [Bun](https://bun.sh) (the installer can install it for you).
- [tmux](https://github.com/tmux/tmux), the default multiplexer
  (`CYC_MUX=tmux`); [herdr](https://herdr.dev) is the opt-in upgrade
  (`CYC_MUX=herdr`).
- A path from phone to machine: a [Tailscale](https://tailscale.com) tailnet
  away from the desk, or plain localhost on one machine.
- At least one coding agent: Claude Code, Codex, OpenCode or Pi.

## What is inside

- `engine/agent-engine` (:10101): the agent engine. Knows what a session is,
  drives the multiplexer, holds the chat log, seals the transport, delivers to
  and from panes.
- `engine/voice-engine` (:10102): in-process sherpa-onnx TTS and STT behind a
  loopback-only HTTP contract.
- `engine/mcp`: the per-session MCP server that gives an agent its output
  tools: `speak`, `chat`, `show`, `info`.
- `engine/harness`: per-harness integration (codex hooks, the opencode
  plugin, the pi extension), installed into each detected agent.
- `engine/skills`: the `callyourcode` skill that teaches an agent how to use
  cyc.
- `app`: the PWA (Vite + TypeScript) you open on your phone.
- `server` (:10100): serves the app, owns everything device-shaped (push,
  settings), and runs the blind signaling relay and STUN/TURN.
- `scripts`: the installer, service control, the `cyc` CLI, and the harness
  integration.
- `testbench`: the reliability matrix for mux and harness binding, one Docker
  cell per (harness, version, mux, scenario).

## Running the tests

Run each from its package directory:

- `engine/agent-engine`: `bun run test`, `bun run test:e2e`, `bun run typecheck`.
- `engine/voice-engine`: `bun run test`, `bun run typecheck`.
- `server`: `bun run test`, `bun run typecheck`.
- `app`: `npm test`, `npm run test:playwright`, `npx tsc --noEmit -p .`.
- `scripts`: `bun test scripts/cyc.test.ts` and siblings, by path.
- `testbench`: via `testbench/run.ts` (see `testbench/README.md`).

## The privacy model, precisely

- **Sealed.** The phone-to-engine channel is an end-to-end encrypted WebRTC
  DataChannel; content keys are derived per generation, and chat and push
  previews are sealed with AES-256-GCM before they ever hit the wire.
- **The hosted app server is a blind matchmaker.** It forwards signaling
  frames verbatim, maps a per-engine token to an owner, and forwards sealed
  push blobs. It never sees chat text, voice audio, file or diff contents, or
  push preview plaintext; every frame it touches is an opaque string.
- **Key-gated enrolment.** An unknown device must prove it holds a live
  content-generation key before the engine enrolls it, on every transport.
- **The local path has no server at all.** Over localhost or your own
  tailnet, nothing of ours sits between your phone and your machine; the
  hosted server exists only to match a phone that cannot reach the engine
  directly.
