/** Durable bubble identity, shared by the engine's pin lookup and the app. */
export function rowIdOfMessage(m: {
  cid?: string; mid?: string; ts: number; role: string; text: string;
}): string {
  if (m.cid) return `m:c:${m.cid}`;
  if (m.mid) return `m:${m.mid}`;
  return `m@${m.ts}|${m.role}|${m.text}`;
}

export type MessagePin = {
  id: string;
  role: "user" | "claude";
  ts: number;
  seq?: number;
  snippet: string;
  pinnedAt: number;
};
export type MessagePinUpdate = { id: string; pinned: boolean };
export const MESSAGE_PIN_CAP = 50;

export function parseMessagePins(value: unknown): MessagePin[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((p): p is MessagePin => {
    if (!p || typeof p.id !== "string" || !p.id || seen.has(p.id) ||
      (p.role !== "user" && p.role !== "claude") ||
      !Number.isFinite(p.ts) || !Number.isFinite(p.pinnedAt) ||
      typeof p.snippet !== "string" ||
      (p.seq !== undefined && (!Number.isInteger(p.seq) || p.seq < 0))) return false;
    seen.add(p.id);
    return true;
  }).sort((a, b) => b.pinnedAt - a.pinnedAt).slice(0, MESSAGE_PIN_CAP)
    .map((p) => ({...p, snippet: p.snippet.slice(0, 120)}));
}
