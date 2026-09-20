# 09. Adapters (harness readers + the mux seam)

## Purpose

The two freedoms (PRODUCT.md section 2): any harness (claude, codex, opencode,
pi are equal citizens) and any mux (tmux default, herdr opt-in). Harness logic
lives in the harness reader, mux logic in the mux adapter, core bothers with
neither: no "if claude" branch in core, core never knows the word "pane".
Adding a harness is adding a reader; adding a mux is adding an adapter.

## Parties and transport

In-process seams, not wires:
- `HarnessReader` (NORMATIVE: `engine/agent-engine/src/readers/types.ts`, the
  doc comments there ARE the contract): one agent's transcript story.
  Implementations: `readers/claude.ts`, `codex.ts`, `opencode.ts`, `pi.ts`.
- `MultiplexerAdapter` (NORMATIVE: the interface block in
  `adapters/mux-adapter.ts`): the agent-shaped seam core drives.
  Implementations: `MuxAdapter` (herdr) and `TmuxMuxAdapter`; chosen by
  `adapters/factory.ts` from `CYC_MUX` (default tmux).

## HarnessReader (types.ts wins on detail)

`tag`; `capabilities` (`HarnessCaps {context: "native"|"transcript",
compact?, usage?}`, the ONE place a harness declares its meta profile, so the
capability core derives resolvers from the READERS table instead of a switch);
`detect(input)`; `locate(ref, cwd)`; `parse`/`parseLine` (snapshot /
incremental -> `AgentEvent`); `turnEdge`; `contextPct`/`model`/`title`/`runs`/
`messages`; `parseScreen` (blocked dialogs, `Ask`);
`launch {command, resume(id)}`; `quit {waitMs?, keys?}` (the restart ladder's
gone-wait and quit sequence, declared by the reader, not hardcoded in the
ladder); `inputDelivery` (`InputDelivery` = `"keystroke"` default |
`"direct"`); `eventSocket` + `launchAugment` (the pi per-pane unix socket:
spawn binds it and decorates the launch command by DATA, no branch in spawn).

## MultiplexerAdapter (mux-adapter.ts wins)

`capabilities()` (`MuxCapabilities {terminalViewer, typedInput}`);
`start`/`listAgents`/`onAgents` (`MuxAgentInfo`: `handle` is MUX-OPAQUE, core
stores it and never parses it); `resolveHandle(envId)` (the MCP pane-id ->
handle resolution, core never sees the pane id again); `conversation`/
`conversationRuns`/`parseScreen`/`transcriptFile`/`transcriptPathFor`/
`readTitle`/`contextModelRead`/`streamTranscriptLines`; the tail seam
(`subscribe`, `readTranscriptSpan`, `subscribeStatus`, `sweepTails`,
`subscribePiEvents`); input (`sendInput`, `interrupt`, `inputMethod`,
`registerDirectInput`, raw `sendText`/`sendKeys` for the two shell-typing
sites); reader-derived capability reads (`canParseScreen`, `hasTranscript`,
`launchCommand`, `resumeCommand`, `launchableKinds`, `harnessProfiles`,
`quitWaitMs`, `quitKeys`, `contextRead`); terminal driver facts
(`terminalPaneMode`, `terminalCanResize`); spawn verbs.

## Brokered input (PRODUCT.md section 5)

Harness-native input first where a live direct endpoint is registered (pi's
RPC `prompt`), mux keystrokes as the universal fallback; declaring `direct`
never strands a message. The delivery guarantee lives at this seam: `deliverToPane`
(defined ONCE in `mux-adapter.ts` so server.ts cannot drift a copy) refuses
rather than lies: a refused send says what was and was not typed and stays
retriable; a pane showing a modal is never answered by accident.

## Identity

`AgentId` is core's own stable id; harness session ids (`harnessSessionId`,
`AgentSessionRef`) are facts the adapter carries and core hides from the app;
`sessions/carry.ts` keeps the chat attached across id rollover, pane restart,
engine restart, and mux epoch.

## Extension

Both seams are additive: a new reader member is optional with a declared
absence story ("absent means the shipped default", spelled per field in
types.ts); a new adapter verb joins the interface where every implementation
must have it (spawn-side verbs are required). The READERS table order is the
one source of truth for kind lists; adding a reader adds its kind, profile,
launch entry and capabilities everywhere, with no core edit.

## Failure semantics

- Unreadable screen/dialog: `blocked {ask: null, why:
  "unread"|"unrecognised"|"unsupported"}`, labeled, never guessed.
- A harness that outlasts the quit window is refused plainly ("did not take
  ctrl+c") rather than typed over; its reader can widen ITS ceiling.
- A mux with `terminalViewer:false` refuses term-open with a plain
  `term-closed` reason (contract 02).
- Direct-input endpoint gone: automatic keystroke fallback.

## Security invariants

- Core never opens a transcript path or parses a pane id; all file and pane
  access goes through the adapter, which is what keeps a foreign harness or mux
  from widening core's reach.
- Input reaches ONLY sessions the engine tracks; the delivery guard reads the
  screen first where the reader can parse it.
- Launch decoration is reader-declared data, never string-sniffing of user
  commands.
