export type RecordingKey = string;

type RecordingEntry = {
  parkedMsgId?: string;
  handoffTimer?: number;
  vaultKey?: string;
  committed?: true;
};

export interface RecordingLedger {
  key(captureId: number | undefined, localId: string): RecordingKey;
  for(captureId?: number, localId?: string): RecordingKey | null;
  entry(key: RecordingKey): RecordingEntry;
  get(key: RecordingKey): RecordingEntry | undefined;
  claim(key: RecordingKey): boolean;
  cancelHandoff(key: RecordingKey | null): void;
  scheduleHandoff(key: RecordingKey, callback: () => void, delay: number): void;
}

export function createRecordingLedger(): RecordingLedger {
  const recordings = new Map<RecordingKey, RecordingEntry>();
  const entry = (key: RecordingKey) => {
    let value = recordings.get(key);
    if (!value) {
      value = {};
      recordings.set(key, value);
      if (recordings.size > 32) {
        for (const oldKey of [...recordings.keys()].slice(0, recordings.size - 32)) {
          recordings.delete(oldKey);
        }
      }
    }
    return value;
  };
  const key = (captureId: number | undefined, localId: string) =>
    captureId !== undefined ? `c${captureId}` : `l${localId}`;
  return {
    key,
    for: (captureId, localId) =>
      captureId !== undefined || localId !== undefined ? key(captureId, localId ?? '') : null,
    entry,
    get: (recordingKey) => recordings.get(recordingKey),
    claim: (recordingKey) => {
      const recording = entry(recordingKey);
      if (recording.committed) return false;
      recording.committed = true;
      return true;
    },
    cancelHandoff: (recordingKey) => {
      if (!recordingKey) return;
      const recording = recordings.get(recordingKey);
      if (recording?.handoffTimer) {
        clearTimeout(recording.handoffTimer);
        delete recording.handoffTimer;
      }
    },
    scheduleHandoff: (recordingKey, callback, delay) => {
      const recording = entry(recordingKey);
      if (recording.handoffTimer) clearTimeout(recording.handoffTimer);
      recording.handoffTimer = window.setTimeout(() => {
        delete recording.handoffTimer;
        callback();
      }, delay);
    }
  };
}
