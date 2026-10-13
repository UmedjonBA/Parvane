import { describe, expect, it, vi } from 'vitest';

import type { WireStoredMessage } from '../wire';

import { createMessageIndex } from './messageIndex';

function row(id: string): WireStoredMessage {
  return {
    id, from: 'bob@local', to: 'alice@local', ts: 1, content: { kind: 'text', text: id },
  };
}

describe('message index (perf A2)', () => {
  it('serves hits from memory without touching the history', async () => {
    const loadAll = vi.fn(() => Promise.resolve([] as WireStoredMessage[]));
    const index = createMessageIndex({ loadAll });
    index.set(row('a'));
    expect(await index.find('a')).toEqual(row('a'));
    expect(loadAll).not.toHaveBeenCalled();
  });

  it('reads the whole history once per session on a miss, then only single records', async () => {
    const loadAll = vi.fn(() => Promise.resolve([row('cached')]));
    const loadOne = vi.fn((uuid: string) => Promise.resolve(uuid === 'late' ? row('late') : undefined));
    const index = createMessageIndex({ loadAll, loadOne });

    expect(await index.find('cached')).toEqual(row('cached'));
    expect(await index.find('missing')).toBeUndefined();
    expect(await index.find('missing-2')).toBeUndefined();
    expect(loadAll).toHaveBeenCalledTimes(1);
    // Первый промах закрыт полным чтением; дальнейшие — одной записью
    expect(loadOne).toHaveBeenCalledTimes(2);
    expect(await index.find('late')).toEqual(row('late'));
    // Найденная запись осталась в индексе
    expect(await index.find('late')).toEqual(row('late'));
    expect(loadOne).toHaveBeenCalledTimes(3);
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('keeps rows set live over rows from the history read', async () => {
    const live = { ...row('x'), edited: true };
    const index = createMessageIndex({ loadAll: () => Promise.resolve([row('x')]) });
    index.set(live);
    await index.find('nothing');
    expect(index.get('x')).toBe(live);
  });

  it('clear() forgets rows and allows one more full read', async () => {
    const loadAll = vi.fn(() => Promise.resolve([row('a')]));
    const index = createMessageIndex({ loadAll });
    await index.find('zzz');
    index.clear();
    expect(index.size()).toBe(0);
    await index.find('a');
    expect(loadAll).toHaveBeenCalledTimes(2);
  });
});
