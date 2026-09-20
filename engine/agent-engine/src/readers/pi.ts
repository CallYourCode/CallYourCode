// The pi HarnessReader (LANE B, design Gap 1). Replaces the transcript-only
// placeholder `readerFromTranscript("pi", PI_TRANSCRIPT)` (adapters/mux-adapter.ts)
// with a first-class reader modelled on readers/codex.ts and readers/claude.ts.
//
// FAITHFUL BY CONSTRUCTION, like the codex/opencode readers. Every transcript
// method delegates to the fixture-proven PI_TRANSCRIPT (chat/transcripts.ts),
// which reads pi's own on-disk jsonl at
//   ~/.pi/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl
// (slug = the cwd with slashes as dashes, wrapped in double dashes). The pi
// session record shape, confirmed READ-ONLY against a real host transcript:
//   {type:"session", version, id:<uuid>, timestamp, cwd}
//   {type:"model_change", id, parentId, provider, modelId}
//   {type:"thinking_level_change", id, parentId, thinkingLevel}
//   {type:"message", id, parentId, timestamp,
//     message:{role:"user"|"assistant"|"toolResult", content, model, provider,
//              api, stopReason, usage:{input,output,cacheRead,cacheWrite,totalTokens,...}}}
// There is no fork/previous pointer at the session-record top level; a forked
// session is a fresh file with its own id (pi's `--fork` writes a new session),
// so lineage is proven from transcript CONTENT (lineage.ts), not a stored link.
//
// What pi ADDS over the placeholder: LAUNCH/RESUME commands (pi has real resume
// verbs, so `resume` returns a command, it is not fabricated) and a declared
// DIRECT input method (adapters/pi-direct.ts).
//
// MODEL: pi records its model id (grok-4.6, claude-opus-4-8, deepseek-chat).
// The reader surfaces that RAW id, exactly as the codex and opencode readers
// surface theirs -- the sessions row carries the harness's own id, and the ONE
// model-name mapper (sessions/model-names.ts: grok-4.6 -> "Grok 4.6") is applied
// at the app/model-indicator layer, not here. Mapping inside the reader would
// diverge from codex/opencode and break the sessions-row contract that draws
// "Pi . grok-4.6" from the raw id.
//
// What pi does NOT implement, returned as the documented empty shape and never
// thrown: title() is null (pi's `--name` is not read back from the transcript
// here) and runs() is [] (AgentRun parsing is claude-only; the background
// pi-run/pi-workflow lane recognizer is adapters/piagent.ts, a SEPARATE seam).
// parseScreen is omitted (no pi TUI dialog parser yet), exactly as codex.

import { PI_TRANSCRIPT } from "../chat/transcripts.ts";
import { augmentPiLaunch, PI_EXTENSION_PATH } from "../adapters/pi-launch.ts";
import type { HarnessReader } from "./types.ts";

export const piReader: HarnessReader = {
  tag: "pi",

  // reads-only, the same shape as codex / opencode: model + pct off the
  // transcript read, so pi's usage/context bar degrades cleanly instead of pi
  // being silently absent from the capability domain.
  capabilities: { context: "transcript" },

  detect(input) {
    return input.kindStamp === "pi";
  },

  // The pi session locate: ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl,
  // by session id under the cwd slug (or a direct path ref).
  locate: PI_TRANSCRIPT.locate,

  // Working/idle from the pi transcript tail: a user turn or a toolUse stop is
  // working; a stop/error/length stop reason is idle.
  turnEdge: PI_TRANSCRIPT.turnEdge,

  // Newest assistant usage (input+cacheRead+cacheWrite) against the model's
  // window; null only when no assistant turn has been written yet.
  contextPct: PI_TRANSCRIPT.contextPct,

  // pi's own model id (raw), like codex/opencode; friendly-named downstream.
  model: PI_TRANSCRIPT.model,

  // Conversation turns (user + assistant text), filtered of empty content.
  messages: PI_TRANSCRIPT.messages,

  // Not implemented for pi: no title reader, no agent-run parser (piagent.ts is
  // a separate background-lane recognizer, not this pane reader).
  async title() { return null; },
  async runs() { return []; },

  // How to spawn / resume a pi pane. `pi` is the shipped binary end users have
  // on PATH; auth and providers are pi's own config, so there is no wrapper and
  // every cyc-added flag/env passes straight to the real binary.
  // pi HAS a real resume verb -- `--session <path|id>` resumes a prior session
  // by its (partial) uuid -- so `resume` returns that command; it is NOT
  // fabricated. (`--continue`/`-c` resumes the newest session; `--fork` starts
  // a NEW session from a prior one, which is start-not-resume, so it is not the
  // resume verb here.)
  launch: {
    command: "pi",
    resume: (sessionId: string) => `pi --session ${sessionId}`,
  },

  // PI GETS A WIDER GONE-WAIT than the 20s the restart ladder gives
  // claude/codex/opencode: pi can linger in the mux listing after its quit,
  // long enough that a resume-mode restart refused it a beat before pi
  // actually left (one host, w1:p4). The 40s is still a ceiling
  // waitForAgentGone returns early from, so a prompt quit is not slowed, and
  // it stays under the app's 60s restart timeout (app/store/sessionOps.ts)
  // with room for the shell pause and screen watch. Env CYC_RESTART_GONE_MS_PI
  // overrides it (pane-deliver.ts, tests).
  //
  // PI DOES NOT QUIT ON CTRL+C AT ALL (measured on one host): three ctrl+c
  // presses 500ms apart into a live idle pi pane leave it alive 60s later,
  // still listed, pane unchanged -- so the default ladder's ctrl+c-only quit
  // can never take pi down, and the wider gone-wait above cannot help a quit
  // that never starts. pi's quit is EOF: ONE ctrl+d at an EMPTY input exits it
  // to the shell immediately. So the sequence is ctrl+c (clears any pending
  // input, leaving the box empty) then a SINGLE ctrl+d (the quit). Never send a
  // second ctrl+d: once pi exits the pane holds a shell, and a further ctrl+d
  // there would close the pane itself.
  quit: { waitMs: 40_000, keys: ["ctrl+c", "ctrl+d"] },

  // PI STREAMS LIVE EVENTS + ITS OWN SESSION ID over a per-pane unix socket
  // (adapters/pi-events.ts). Declaring eventSocket has the adapter's spawn bind
  // a PiEventServer before pi starts, decorate the launch through launchAugment
  // below, and attach the identity tap -- the pi-specific spawn work that used
  // to be a command-string sniff in the generic spawn path, now driven by this
  // reader declaration. Every non-pi harness omits it and spawns untouched.
  eventSocket: true,

  // Decorate a pi launch so the cyc-launched pi loads the output extension and
  // points it at the bound socket: a leading `CYC_PI_EVENT_SOCK=<sock>` env
  // assignment plus a trailing `-e <cyc-output.js>` flag (both are plain pi
  // flags/env, so they pass to the real binary directly). This is the CURRENT
  // augmentPiLaunch output verbatim -- the
  // adapter used to call augmentPiLaunch itself; the reader owns it now, so the
  // augmented command is byte-for-byte what it was for the same launch + sock.
  launchAugment(command, ctx) {
    return augmentPiLaunch(command, { extensionPath: PI_EXTENSION_PATH, sockPath: ctx.sockPath }).command;
  },

  // pi input can be delivered DIRECTLY (design Gap 1, product spec), through
  // pi's supported RPC `prompt` command rather than mux keystrokes. Declared
  // here; the adapter routes pi input through the direct path when a live pi
  // RPC endpoint is registered for the pane, and falls back to keystrokes
  // otherwise (adapters/pi-direct.ts, adapters/mux-adapter.ts sendInput).
  inputDelivery: "direct",
};
