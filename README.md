<p align="center">
  <img src="docs/media/banner.png" alt="CallYourCode. Talk to your terminal coding sessions from a chat app." width="820">
</p>

**Talk to your own coding agents from your phone, in your own voice.**

Your agents already live in a terminal on your machine. CallYourCode (cyc)
puts every one of them in your pocket: each pane becomes a chat with a voice,
on a page you open locally or over Tailscale. You speak, the words land in the pane as
ordinary terminal input, the agent works, and it speaks the result back.

Your own app-server relays sealed traffic. Speech processing stays on your
machine. Your hardware, your tailnet, your agents.

## The wow moment

Walk away from the desk. Your phone rings itself into a conversation: an agent
finishes a task and speaks the result. You answer out loud, "run the tests
again and tell me what broke," and the agent keeps going. The whole loop runs
on your own hardware over your own network.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/terminal-dark.webp">
    <img src="docs/media/terminal.webp" alt="A tmux pane running Claude Code: the phone's message arrives as terminal input and the agent replies through cyc" width="560">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/phone-dark.webp">
    <img src="docs/media/phone.webp" alt="The same conversation as a chat on the phone: a written reply and a voice note back" width="190">
  </picture>
</p>

## Why it is different

- **Private by construction.** The phone-to-machine link is a sealed,
  end-to-end encrypted WebSocket relay channel. Chat text, voice audio, files,
  diffs: none of it touches a third party.
- **Local speech.** Speech is synthesized and transcribed
  in-process by sherpa-onnx (kokoro for text to speech, whisper for speech to
  text). No Python, no API key, no audio goes to a remote speech service.
- **Your agents, unchanged.** Claude Code, Codex, OpenCode and Pi keep
  running where they always have, in tmux (or herdr) on your machine. cyc
  wires into them; it does not replace them.
- **Nothing between you and it.** Three Bun/TypeScript services and a PWA.
  Over your own tailnet, or plain localhost, there is no company server at
  all.

## What it is, in one picture

```mermaid
flowchart LR
  subgraph phone [Your phone]
    APP["The app (PWA)<br/>offline-first chat"]
  end
  subgraph machine [Your machine]
    ENG[Agent engine]
    VOICE["Voice engine<br/>(local STT + TTS)"]
    subgraph mux [tmux or herdr]
      C[Claude Code]
      X[Codex]
      O[OpenCode]
      P[Pi]
    end
  end
  SRV["Your app-server<br/>(page, discovery,<br/>sealed data and push relay)"]
  APP <==>|"sealed E2E over WS"| SRV
  SRV <==>|"outbound engine WS"| ENG
  ENG <--> VOICE
  ENG <--> C & X & O & P
```

One sealed, end-to-end encrypted WebSocket channel through your app-server
carries chat, voice, files, diffs, terminal frames and plugin pages. Open the
app-server on localhost or through your own Tailscale HTTPS origin. No company
server is involved. Restarting the app-server interrupts active connections;
the app reconnects, handshakes afresh and reattaches while local agents keep
running.

## The two freedoms

**Any harness.** Claude Code, Codex, OpenCode and Pi are equal citizens. Each
gets the same treatment: replies in the chat, voice both ways, status,
history, context and model shown, permission prompts surfaced as answerable
questions. Adding a harness is adding an adapter, never a special case.

**Any mux.** tmux is the default, because people already have it and know it.
herdr is the opt-in upgrade. Both work at once.

**Zero commitment.** cyc sits over the panes; it never replaces them. The
terminal underneath stays fully usable: you can sit down at the desk
mid-conversation and just keep typing. Sessions come from the mux,
hand-started panes included; the transcripts are the harnesses' own. Killing
cyc loses nothing.

## How the app behaves

**Offline first, like WhatsApp.** Everything is visible with no network:
chats, photos, voice notes, shown documents. The app cold-starts offline.
Every user action applies locally the instant it happens, is stored durably,
and drains to the engine when it is reachable. Sends show instantly and retry
with the same identity until acknowledged; a genuinely failed delivery is
shown plainly (red row, tap to retry), never silently lost. Losing user
input is the cardinal sin.

**Chat-app-grade feel.** Scrolling follows the finger. Unread markers and
mark-as-unread. Reply quoting with jump-back. Voice notes with slide-to-lock
and live transcription. A global audio player. Session activity as muted
pills, not noise. Quiet when idle: the app does not rerender constantly, and
a phone running hot is treated as a product bug.

**AI as a first-class citizen.** Streaming replies with a thinking
indicator. Voice-first ordering on agent replies: the spoken line lands
before the text bubble. Permission dialogs arrive as questions you can answer
from the phone. The agent can push files, diffs, images and whole interactive
pages into the chat. A live terminal view of the real pane is one tap away.

**Extensions ship as plugins.** Crons (schedules and reminders), the model
indicator, Git and Files pages, the TUI view: product features are plugins
with their own UI, on three declared surfaces (a card in the conversation, a
declarative composer widget, a toolbar entry opening a sandboxed panel).
Engines declare, the app renders. This is also the community contribution
surface, with enforced caps rather than advisory ones.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/plug-crons-dark.webp">
    <img src="docs/media/plug-crons.webp" alt="The Crons panel beside a conversation: two recurring schedules with toggles and next-run times." width="720">
  </picture>
</p>

One roster, every agent on the machine: Claude Code, Codex, OpenCode and Pi,
each with its model, its crons, its git and files pages, and a TUI view.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/laptop-dark.webp">
  <img src="docs/media/laptop.webp" alt="The CallYourCode app on a laptop: a roster of Claude Code, Codex, OpenCode and Pi agents, one conversation open.">
</picture>

And the real pane itself is one tap away, live inside the app:

<p align="center">
  <img src="docs/media/plug-terminal.webp" alt="The TUI view: the agent's actual Claude Code pane, live inside the app." width="720">
</p>

## Get started in two minutes

One line installs everything: Bun if missing, the repo to `~/callyourcode`,
wiring for every agent it detects, and the services:

```sh
curl -fsSL https://callyourcode.com/install.sh | sh
```

Then link your phone and go:

```sh
cyc pair      # a local or Tailscale pairing link and QR
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
  settings), and runs the blind sealed WebSocket data relay.
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

- **Sealed.** The phone-to-engine channel is an end-to-end encrypted WebSocket
  relay channel; content keys are derived per generation, and chat and push
  previews are sealed with AES-256-GCM before they ever hit the wire.
- **Your app-server is a blind data relay.** It authenticates the engine's
  registration token, forwards sealed frames and encrypted push blobs, and
  holds no content keys. It sees routing IDs and traffic metadata, never chat,
  audio, file contents or push-preview plaintext.
- **Key-gated enrolment.** An unknown device must prove it holds a live
  content-generation key before the engine enrolls it, on every transport.
- **Local or Tailscale only.** Your app-server is required for browser sync,
  including on localhost. Pairing keys stay in URL fragments and encrypted
  device storage. Keep keys, data and app-server state when upgrading.
