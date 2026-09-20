import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  static afterDelivery: (() => void) | undefined;
  private listeners: Array<(event: MessageEvent) => void> = [];

  constructor(_name: string) {
    FakeBroadcastChannel.channels.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.push(listener);
  }

  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel === this) continue;
      for (const listener of channel.listeners) listener({data} as MessageEvent);
    }
    FakeBroadcastChannel.afterDelivery?.();
  }
}

const box = () => {
  let draft = '';
  let blocks: never[] = [];
  return {
    getBlocks: () => blocks,
    setBlocks: vi.fn((next: never[]) => {
      blocks = next;
    }),
    getDraft: () => draft,
    setDraft: vi.fn((next: string) => {
      draft = next;
    })
  };
};

describe('composer vault sent-draft ordering', () => {
  beforeEach(() => {
    localStorage.clear();
    FakeBroadcastChannel.channels = [];
    FakeBroadcastChannel.afterDelivery = undefined;
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as {locks?: unknown}).locks;
  });

  test('a tab opened as the sent broadcast arrives cannot restore the sent text', async () => {
    localStorage.setItem('cyc-drafts', JSON.stringify({s1: 'delivered words'}));
    const {createComposerVaultBridge} =
      await import('../features/composer/persistence/vaultBridge');
    const senderBox = box();
    const receiverBox = box();
    const sender = createComposerVaultBridge({box: () => senderBox});
    const receiver = createComposerVaultBridge({box: () => receiverBox});
    sender.loadDraft('s1');
    receiver.loadDraft('s1');

    const reloadBox = box();
    FakeBroadcastChannel.afterDelivery = () => {
      const reload = createComposerVaultBridge({box: () => reloadBox});
      reload.loadDraft('s1');
    };

    sender.dropDraft('s1', sender.draftIdentity('s1', 'delivered words'));

    expect(reloadBox.getDraft()).toBe('');
    expect(JSON.parse(localStorage.getItem('cyc-drafts') ?? '{}')).not.toHaveProperty('s1');
  });

  test('a late commit for A leaves B available after reload', async () => {
    localStorage.setItem('cyc-drafts', JSON.stringify({s1: 'A'}));
    const {createComposerVaultBridge} =
      await import('../features/composer/persistence/vaultBridge');
    const senderBox = box();
    const sender = createComposerVaultBridge({box: () => senderBox});
    sender.loadDraft('s1');
    const sent = sender.draftIdentity('s1', 'A');

    senderBox.setDraft('B');
    sender.saveDraft();
    sender.dropDraft('s1', sent);

    const reloadBox = box();
    const reload = createComposerVaultBridge({box: () => reloadBox});
    reload.loadDraft('s1');
    expect(reloadBox.getDraft()).toBe('B');
  });

  test('a late commit in one tab does not delete a newer shared draft from another tab', async () => {
    localStorage.setItem('cyc-drafts', JSON.stringify({s1: 'A'}));
    const {createComposerVaultBridge} =
      await import('../features/composer/persistence/vaultBridge');
    const firstBox = box();
    const secondBox = box();
    const first = createComposerVaultBridge({box: () => firstBox});
    const second = createComposerVaultBridge({box: () => secondBox});
    first.loadDraft('s1');
    second.loadDraft('s1');
    const sent = first.draftIdentity('s1', 'A');

    secondBox.setDraft('B');
    second.saveDraft();
    first.dropDraft('s1', sent);

    expect(JSON.parse(localStorage.getItem('cyc-drafts') ?? '{}')).toEqual({
      s1: {text: 'B', revision: 1}
    });
    const reloadBox = box();
    createComposerVaultBridge({box: () => reloadBox}).loadDraft('s1');
    expect(reloadBox.getDraft()).toBe('B');
  });

  test('a sent broadcast does not clear a newer draft in another tab', async () => {
    localStorage.setItem('cyc-drafts', JSON.stringify({s1: 'A'}));
    const {createComposerVaultBridge} =
      await import('../features/composer/persistence/vaultBridge');
    const firstBox = box();
    const secondBox = box();
    const first = createComposerVaultBridge({box: () => firstBox});
    const second = createComposerVaultBridge({box: () => secondBox});
    first.loadDraft('s1');
    second.loadDraft('s1');
    const sent = first.draftIdentity('s1', 'A');

    secondBox.setDraft('B');
    second.saveDraft();
    first.dropDraft('s1', sent);

    expect(secondBox.getDraft()).toBe('B');
    expect(secondBox.setDraft).not.toHaveBeenCalledWith('');
  });

  test('a Web Lock serializes a concurrent save after the sent draft delete', async () => {
    localStorage.setItem('cyc-drafts', JSON.stringify({s1: 'A'}));
    let tail: Promise<void> = Promise.resolve();
    const locks = {
      request: vi.fn((_name: string, work: () => void | Promise<void>): Promise<void> => {
        const result = tail.then(() => work());
        tail = result.then(
          (): void => undefined,
          (): void => undefined
        );
        return result;
      })
    };
    Object.defineProperty(navigator, 'locks', {configurable: true, value: locks});
    const {createComposerVaultBridge} =
      await import('../features/composer/persistence/vaultBridge');
    const firstBox = box();
    const secondBox = box();
    const first = createComposerVaultBridge({box: () => firstBox});
    const second = createComposerVaultBridge({box: () => secondBox});
    first.loadDraft('s1');
    second.loadDraft('s1');
    const sent = first.draftIdentity('s1', 'A');

    const setItem = Storage.prototype.setItem;
    let saving = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ): void {
      if (!saving && key === 'cyc-drafts') {
        saving = true;
        secondBox.setDraft('B');
        second.saveDraft();
      }
      return setItem.call(this, key, value);
    });
    first.dropDraft('s1', sent);
    await Promise.resolve();
    await tail;

    expect(locks.request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem('cyc-drafts') ?? '{}')).toEqual({
      s1: {text: 'B', revision: 0}
    });
  });

  test('a failed durable read retains the sent draft and does not broadcast a clear', async () => {
    localStorage.setItem('cyc-drafts', JSON.stringify({s1: 'A'}));
    const {createComposerVaultBridge} =
      await import('../features/composer/persistence/vaultBridge');
    const senderBox = box();
    const receiverBox = box();
    const sender = createComposerVaultBridge({box: () => senderBox});
    const receiver = createComposerVaultBridge({box: () => receiverBox});
    sender.loadDraft('s1');
    receiver.loadDraft('s1');
    receiverBox.setDraft.mockClear();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('temporarily unavailable');
    });

    sender.dropDraft('s1', sender.draftIdentity('s1', 'A'));
    getItem.mockRestore();

    expect(receiverBox.setDraft).not.toHaveBeenCalledWith('');
    expect(JSON.parse(localStorage.getItem('cyc-drafts') ?? '{}')).toEqual({s1: 'A'});
  });

  test('a revision at the safe-integer edge wraps to a readable new draft', async () => {
    localStorage.setItem(
      'cyc-drafts',
      JSON.stringify({s1: {text: 'A', revision: Number.MAX_SAFE_INTEGER}})
    );
    const {createComposerVaultBridge} =
      await import('../features/composer/persistence/vaultBridge');
    const senderBox = box();
    const sender = createComposerVaultBridge({box: () => senderBox});
    sender.loadDraft('s1');
    senderBox.setDraft('B');
    sender.saveDraft();

    expect(JSON.parse(localStorage.getItem('cyc-drafts') ?? '{}')).toEqual({
      s1: {text: 'B', revision: 0}
    });
    const reloadBox = box();
    createComposerVaultBridge({box: () => reloadBox}).loadDraft('s1');
    expect(reloadBox.getDraft()).toBe('B');
  });
});
