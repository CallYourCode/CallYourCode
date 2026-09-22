import {afterEach, describe, expect, test} from 'vitest';
import type {CycSession} from '../types';
import {renderMessages, clearMessages} from '../features/chat/surface/messageList';
import {noteSynced, __resetLiveForTest} from '../engine/sync';

// coldsync: on a fresh device the first chat sync can run for tens of seconds;
// an opened empty chat must not claim 'No messages here yet' while months of
// messages may still be on their way. The chat's first sync is settled exactly
// when sync.syncedAt(sessionId) is set (the first attach-ok, or the persisted
// meta of an earlier sync), so the vacant pill's wording gates on it.

function vacantSession(id: string): CycSession {
  return {id, name: 'x', messages: [], unread: 0} as unknown as CycSession;
}

function pillText(inner: HTMLElement): string {
  return inner.querySelector('.cyc-vacant-chat .cyc-service-text')?.textContent ?? '';
}

afterEach(() => __resetLiveForTest());

describe('the vacant-chat pill and the first sync', () => {
  test('an unsynced empty chat reads as loading, not empty', () => {
    const inner = document.createElement('div');
    renderMessages(inner, vacantSession('s-cold'), () => {});
    expect(pillText(inner)).toBe('Loading messages...');
    clearMessages(inner);
  });

  test('a settled empty chat keeps the empty wording', () => {
    const inner = document.createElement('div');
    noteSynced('s-warm', Date.now());
    renderMessages(inner, vacantSession('s-warm'), () => {});
    expect(pillText(inner)).toBe('No messages here yet');
    clearMessages(inner);
  });

  test('the loading pill settles into the empty pill once sync lands', () => {
    const inner = document.createElement('div');
    const s = vacantSession('s-lands');
    renderMessages(inner, s, () => {});
    expect(pillText(inner)).toBe('Loading messages...');
    noteSynced('s-lands', Date.now());
    renderMessages(inner, s, () => {});
    expect(pillText(inner)).toBe('No messages here yet');
    clearMessages(inner);
  });
});
