import {describe, expect, test} from 'vitest';
import {TEST_FIXTURE_NAMES, TEST_HOSTS} from '../testing/testFixtures';
import {testEngineSessions, testEngineTabs} from '../testing/testMode';

describe('test mode fixtures', () => {
  test('two hypothetical hosts, short list then a long one', () => {
    expect(TEST_HOSTS).toHaveLength(2);
    expect(TEST_HOSTS[0].sessions.length).toBe(3);
    expect(TEST_HOSTS[1].sessions.length).toBeGreaterThan(8);
  });

  test('workshop names match the offline Playwright wait list', () => {
    expect(TEST_HOSTS[0].sessions.map((s) => s.name)).toEqual([...TEST_FIXTURE_NAMES]);
  });

  test('sessions carry engine fields like a live engine row', () => {
    const sessions = testEngineSessions();
    const tabs = testEngineTabs();
    expect(tabs).toHaveLength(2);
    expect(sessions.every((s) => s.cwd && s.messages.length >= 2)).toBe(true);
    expect(new Set(sessions.map((s) => (s as unknown as {engineKey: string}).engineKey)).size).toBe(
      2
    );
  });

  test('rich-message samplers give shots markdown, snippets, a doc chip and a voice clip', () => {
    const sessions = testEngineSessions();
    const byName = (n: string) => sessions.find((s) => s.name === n)!;

    const formatting = byName('Formatting Sampler');
    expect(formatting.messages.some((m) => m.text.includes('## Deploy checklist'))).toBe(true);
    expect(formatting.messages.some((m) => m.text.includes('```ts'))).toBe(true);

    const attachments = byName('Attachment Sampler');
    const files = attachments.messages.filter((m) => m.file);
    expect(files.some((m) => m.file!.fileKind === 'text' && !m.file!.inline)).toBe(true);
    expect(files.some((m) => m.file!.fileKind === 'markdown' && m.file!.inline)).toBe(true);
    expect(files.some((m) => m.file!.fileKind === 'diff' && m.file!.inline)).toBe(true);
    expect(files.every((m) => m.file!.docId)).toBe(true);

    const voice = byName('Voice Sampler');
    const clip = voice.messages.find((m) => m.kind === 'voice')!;
    expect(clip.role).toBe('user');
    expect(clip.durationS).toBe(7);
    expect(clip.text.length).toBeGreaterThan(0);
  });
});
