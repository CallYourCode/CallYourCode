import type {CycFileRef} from '../../types';
import * as sync from '../sync';
import {connOf} from './registry';
import {prefetchDoc} from '../showVault';
import type {CycEngineSession} from './types';

// The shown-document fileKinds the fileViewer and htmlViewer render from the
// vault. Images have their own blob path (showVault.imageBlob, filled on open);
// binaries are downloads, never vaulted documents.
const VAULTABLE_DOC_KINDS = new Set(['markdown', 'diff', 'text', 'html']);

// Receipt hook: vault a shown document the moment its card is admitted, while
// the engine is reachable, so tapping it offline later opens from this device.
// Fire-and-forget; the fetch is only started when reachable and the vault does
// not already hold the doc, so a card that arrives while unreachable is left to
// vault on first online open, as before.
export function prefetchShownDoc(s: CycEngineSession, file: CycFileRef): void {
  if (!VAULTABLE_DOC_KINDS.has(file.fileKind)) return;
  if (!sync.engineReachable(s.engineKey)) return;
  const conn = connOf(s.engineKey);
  if (!conn) return;
  void prefetchDoc(file.docId, conn.client.docUrl(file.docId), s.id);
}
