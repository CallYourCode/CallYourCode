import {connOf, conns, ownerOf, sessions} from './registry';

export function uploadUrl(sessionId: string, uploadId: string): string {
  return ownerOf(sessionId).client.uploadUrl(uploadId);
}

export function audioUrl(sessionId: string, msgId: string): string {
  return ownerOf(sessionId).client.audioUrl(msgId);
}

export function docUrl(sessionId: string, docId: string): string {
  return ownerOf(sessionId).client.docUrl(docId);
}

export function notifyKey(sessionId: string): string | null {
  const s = sessions.get(sessionId);
  const conn = s && connOf(s.engineKey);
  if (!s || !conn?.host) return null;
  return `${conn.host}:${s.paneId}`;
}

export function sessionFromNotifyKey(key: string): string | null {
  const at = key.indexOf(':');
  if (at < 0) return null;
  const host = key.slice(0, at);
  const paneId = key.slice(at + 1);
  for (const s of sessions.values()) {
    if (s.paneId !== paneId) continue;
    if (connOf(s.engineKey)?.host === host) return s.id;
  }
  return null;
}

export function setVisible(on: boolean) {
  for (const c of conns) c.client.setVisible(on);
}
