import {connOf, type Conn} from '../registry';
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
  await connOf(engineKey)?.client.paired(userHost);
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
