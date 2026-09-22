import {connOf, conns, type Conn} from '../registry';
import {cyclog} from '@/shared/logging';
import type {HandlerCtx} from './types';

export type PairNeed = {user: string; host: string; onPaired: (userHost: string) => void};

export type IdentityChanged = {user: string; host: string; onTrust: () => void};
let pairNeededHandler: ((n: PairNeed) => void) | null = null;
let downgradedHandler: ((user: string, host: string) => void) | null = null;
let identityChangedHandler: ((n: IdentityChanged) => void) | null = null;
export function onPairNeeded(fn: (n: PairNeed) => void) {
  pairNeededHandler = fn;
}
export function onDowngraded(fn: (user: string, host: string) => void) {
  downgradedHandler = fn;
}
export function onIdentityChanged(fn: (n: IdentityChanged) => void) {
  identityChangedHandler = fn;
}

export async function pairEngine(engineKey: string, userHost: string): Promise<void> {
  /* THE PAIR TAP MUST NEVER DIE IN AN OPTIONAL CHAIN (live 2026-09-22, the
   * hosted first-open bug): a client refused as unknown-device parks on
   * held='pairing', and the ONLY thing that can unpark it is paired() reaching
   * it. The old `connOf(engineKey)?.` swallowed the tap whenever the screen's
   * engine key ('' from a config row without a url, or any key drift) missed
   * the registry, so the key sat stored in the keyring, "Pairing..." painted,
   * and nothing ever redialed; a reload worked because a fresh boot dials with
   * the stored key. When the lookup misses, unpark EVERY client that is not
   * currently connected: paired() on a parked or down client clears the hold
   * and dials with the fresh key; connected engines are left alone so a
   * pairing tap never blips a healthy connection. */
  const hit = connOf(engineKey);
  if (hit) {
    await hit.client.paired(userHost);
    return;
  }
  cyclog('pair.conn-miss', {engineKey, userHost, conns: conns.map((c) => c.state)});
  for (const c of conns) {
    if (c.state === 'connected') continue;
    await c.client.paired(userHost);
  }
}

export function wireSecurity(conn: Conn, _ctx: HandlerCtx): void {
  const client = conn.client;

  client.on('pairNeeded', (user, host) => {
    pairNeededHandler?.({user, host, onPaired: (userHost) => void client.paired(userHost)});
  });
  client.on('downgraded', (user, host) => {
    downgradedHandler?.(user, host);
  });
  client.on('identityChanged', (user, host) => {
    identityChangedHandler?.({user, host, onTrust: () => void client.trustEngine()});
  });
}
