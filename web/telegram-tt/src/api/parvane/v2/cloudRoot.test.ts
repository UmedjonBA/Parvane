import {
  describe, expect, it, vi,
} from 'vitest';

import type { CloudStateEntry } from './cloud';
import type { Protocol, PvClient } from './engine';

import { createCloudSync } from './cloud';

const ID = 'cd'.repeat(16);

// Личный диск создаётся только при подключённом журнале личного состояния: «готово» транспорта наступает раньше,
// и запись о диске, созданном в этом окне, пропадала — на сервере оставался свой контейнер без записи журнала, и
// любая правка диска потом отвергалась (сценарий pwa под нагрузкой: папка не появлялась в «Файлах»)
describe('cloud root creation waits for the state journal', () => {
  it('creates the drive after the journal is attached and records it before the first edit', async () => {
    const events: string[] = [];
    // Журнал состояния отдаёт новый массив после записи (кэш личного диска сравнивает массивы)
    let entries: CloudStateEntry[] = [];
    let isStateReady = false;
    const client = {
      cloudContainers: () => '[]',
      cloudIsAttached: () => true,
      cloudCreate: () => ({
        id: ID, request: { chan: 'id', method: 'domain.container.create', body: new Uint8Array() },
      }),
      cloudShareWithOwnDevices: () => [],
      cloudPrepareLocal: () => {
        events.push('prepare');
        return { opId: 'op', op: new Uint8Array([1]) };
      },
    } as unknown as PvClient;
    const pv = {
      encodeMethodRequest: () => new Uint8Array(),
      decodeMethodResponse: () => '{}',
    } as unknown as Protocol;
    const sync = createCloudSync({
      log: () => undefined,
      pv: () => pv,
      client: () => client,
      isReady: () => true,
      needsLinking: () => false,
      self: () => 'alice@local',
      serverDomain: () => 'local',
      call: (chan, method) => {
        events.push(method);
        return Promise.resolve(new Uint8Array());
      },
      withNeeds: (fn) => Promise.resolve(fn()),
      refreshPeerLog: () => Promise.resolve(),
      persist: () => Promise.resolve(),
      loadRecord: () => Promise.resolve(undefined),
      saveRecord: () => Promise.resolve(),
      deleteRecord: () => Promise.resolve(),
      stateEntries: () => entries,
      isStateReady: () => isStateReady,
      recordEntry: async (entry) => {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        entries = [...entries, entry];
        events.push('entry');
      },
      deleteBlob: () => Promise.resolve(),
      onChanged: () => undefined,
    });

    const applied = sync.apply('root', [{ op: 'create', id: 'ef'.repeat(16), kind: 'folder', name: 'Архив' }]);
    await new Promise((resolve) => {
      setTimeout(resolve, 700);
    });
    expect(events).not.toContain('domain.container.create');

    isStateReady = true;
    await expect(applied).resolves.toBe(ID);
    const created = events.indexOf('domain.container.create');
    expect(created).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('entry')).toBeGreaterThan(created);
    expect(events.indexOf('prepare')).toBeGreaterThan(events.indexOf('entry'));
    expect(sync.rootId()).toBe(ID);
  });

  // Перезагрузка между ответом сервера и записью журнала: контейнер на сервере есть, записи нет. Ключ его сохранён
  // на устройстве до запроса — значит, он создан здесь, и правка подхватывает его личным диском, а не отвергается
  it('adopts its own container left without a journal entry', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let entries: CloudStateEntry[] = [];
      const client = {
        cloudContainers: () => '[]',
        cloudIsAttached: () => true,
        cloudHasKey: (id: string) => id === ID,
        cloudShareWithOwnDevices: () => [],
        cloudPrepareLocal: () => ({ opId: 'op', op: new Uint8Array([1]) }),
      } as unknown as PvClient;
      const refId = btoa(String.fromCharCode(...new Array(16).fill(0xcd)));
      const listed = JSON.stringify({ containers: [{ ref: { id: refId }, owner: { address: 'alice@local' } }] });
      const pv = {
        encodeMethodRequest: () => new Uint8Array(),
        decodeMethodResponse: (method: string) => (method === 'domain.container.list' ? listed : '{}'),
      } as unknown as Protocol;
      const sync = createCloudSync({
        log: () => undefined,
        pv: () => pv,
        client: () => client,
        isReady: () => true,
        needsLinking: () => false,
        self: () => 'alice@local',
        serverDomain: () => 'local',
        call: (chan, method) => {
          events.push(method);
          return Promise.resolve(new Uint8Array());
        },
        withNeeds: (fn) => Promise.resolve(fn()),
        refreshPeerLog: () => Promise.resolve(),
        persist: () => Promise.resolve(),
        loadRecord: () => Promise.resolve(undefined),
        saveRecord: () => Promise.resolve(),
        deleteRecord: () => Promise.resolve(),
        stateEntries: () => entries,
        recordEntry: (entry) => {
          entries = [...entries, entry];
        },
        deleteBlob: () => Promise.resolve(),
        onChanged: () => undefined,
      });

      const applied = sync.apply('root', [{ op: 'create', id: 'ef'.repeat(16), kind: 'folder', name: 'Архив' }]);
      await vi.advanceTimersByTimeAsync(20000);
      await expect(applied).resolves.toBe(ID);
      expect(events).not.toContain('domain.container.create');
      expect(entries).toEqual([{ id: ID, domain: 'local', role: 'root' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
