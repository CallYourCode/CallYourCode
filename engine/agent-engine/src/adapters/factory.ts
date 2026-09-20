/* THE ADAPTER FACTORY, decided from the same env as makeMux (mux.ts). Core
 * builds the MultiplexerAdapter through this rather than wrapping makeMux() by
 * hand, so the tmux path selects the purpose-built TmuxMuxAdapter (TmuxMux +
 * tmuxDriver composed) instead of a MuxAdapter that happened to wrap a raw
 * TmuxMux. Default is herdr: a MuxAdapter that builds its own HerdrClient and
 * herdrDriver.
 *
 * It lives in its own leaf module, not in mux.ts, because mux.ts value-importing
 * the two adapter classes made `mux-adapter -> mux -> tmux-adapter -> class
 * TmuxMuxAdapter extends MuxAdapter` dereference MuxAdapter while
 * mux-adapter.ts was still mid-evaluation. `extends` reads the binding AT
 * MODULE LOAD, so the cycle was never safe; only server.ts imports this file
 * and nothing imports server.ts. */

import { MuxAdapter, type MultiplexerAdapter } from "./mux-adapter.ts";
import { TmuxMuxAdapter } from "./tmux-adapter.ts";

export function makeAdapter(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): MultiplexerAdapter {
  const which = (env.CYC_MUX ?? "tmux").trim().toLowerCase();
  if (which === "herdr") return new MuxAdapter();
  return new TmuxMuxAdapter(env.CYC_TMUX_SOCKET?.trim() || undefined);
}
