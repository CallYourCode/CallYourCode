// pi DIRECT INPUT (LANE B, design Gap 1): deliver a user message straight
// into a LIVE pi session, without mux keystrokes.
//
// THE SUPPORTED MECHANISM, confirmed READ-ONLY against the installed pi binary
// (`pi --help`, and the shipped bundle's `runRpcMode`): pi runs a JSON-LINES
// control protocol when launched with `--mode rpc` (there is also a dedicated
// `pi-rpc` entrypoint that prepends `--mode rpc`). Each line written to pi's
// stdin is one command object `{id, type, ...}`; pi replies with
// `{id, type:"response", command, success, ...}` lines on stdout. The command
// that INJECTS A USER MESSAGE is:
//
//     {"id":"<uuid>","type":"prompt","message":"<text>"}
//
// which pi dispatches as `session.prompt(message, {source:"rpc", ...})` -- the
// same turn a typed-and-submitted keystroke would start, but delivered over the
// control channel. (`steer` and `follow_up` are the mid-turn variants; `prompt`
// is the plain "send him this message" and is what the input seam routes.)
//
// This module owns ONLY the wire framing and a thin endpoint over a writable
// sink. It does NOT launch pi and does NOT assume a running pi: the adapter
// registers an endpoint for a pane only when a live pi RPC channel exists, and
// falls back to keystrokes otherwise. The seam is proven against a FAKE pi
// endpoint (adapters/pi-direct.test.ts); it never touches a real pi session.

/** The minimal writable a pi RPC channel needs: pi's stdin, or a socket, or a
 *  test sink. One newline-terminated JSON line per call. */
export type DirectInputSink = { write(line: string): void | Promise<void> };

/** What the adapter holds for a pane that can take direct input: send one user
 *  message, resolving when the line has been handed to the channel. */
export type DirectInputEndpoint = { send(text: string): Promise<void> };

/** A monotonic-enough id for a prompt command. crypto.randomUUID is what pi's
 *  own RPC layer uses for its ids; matching it keeps the frames indistinguishable
 *  from pi's other clients. */
function promptId(): string {
  return crypto.randomUUID();
}

/** The exact JSON-LINE a pi RPC `prompt` command is, newline-terminated. One
 *  place spells the wire so the endpoint and any test agree byte-for-byte with
 *  what pi's runRpcMode parses. */
export function piPromptFrame(text: string, id: string = promptId()): string {
  return JSON.stringify({ id, type: "prompt", message: text }) + "\n";
}

/** A DirectInputEndpoint over a writable sink (pi's stdin / a socket / a test
 *  sink): writes one `prompt` line per message. The adapter registers one of
 *  these per live pi pane; sendInput calls `.send(text)` instead of typing. */
export function piRpcEndpoint(sink: DirectInputSink): DirectInputEndpoint {
  return {
    async send(text: string): Promise<void> {
      await sink.write(piPromptFrame(text));
    },
  };
}
