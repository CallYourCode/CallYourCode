// Types for the plain-JS pi output extension (cyc-output.js), so the engine's
// test typecheck (tsconfig.tests.json) sees a real signature instead of an
// implicit any. The runtime module is CJS: `module.exports = activate` with a
// `.default` alias, which this default export matches.
//
// `deps` is an optional test seam: a test injects a fake sink (makeSink) whose
// connect timing it controls. pi always calls activate(pi) with one argument.
type PiSink = { send(frame: unknown): void; close(): void };
type ActivateDeps = { makeSink?: (sockPath: string, onConnect?: () => void) => PiSink };
declare const activate: (pi: unknown, deps?: ActivateDeps) => void;
export default activate;
