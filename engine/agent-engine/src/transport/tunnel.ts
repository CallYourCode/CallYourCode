/* Re-export shim: the sealed request/response tunnel codec now lives once in
 * engine/shared/tunnel.ts, imported by both the engine and the
 * app bundle. This shim keeps the engine's transport/ import paths stable. */
export * from "../../../shared/tunnel.ts";
