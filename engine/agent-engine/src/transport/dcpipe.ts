/* Re-export shim: the DataChannel pipe framing now lives once in
 * engine/shared/dcpipe.ts, imported by both the engine and the
 * app bundle. This shim keeps the engine's transport/ import paths stable. */
export * from "../../../shared/dcpipe.ts";
