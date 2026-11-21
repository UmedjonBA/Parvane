import { describe, expect, it } from 'vitest';

import type { CloudStateEntry } from './cloud';
import type { Protocol, PvClient } from './engine';

import { createCloudSync } from './cloud';
import { V2Error } from './transport';

// Владелец закрыл доступ к принятой чужой папке (доски `ZpFilesX`, `ZdFilesX`): папка не исчезает молча — остаётся
// строкой «Нет доступа» с названием, пока пользователь не нажмёт «Убрать»; приглашение без ответа такой строки не даёт
describe('cloud folder closed by its owner', () => {
  function setup(status?: CloudStateEntry['status']) {
    const ID = 'ef'.repeat(16);
    const records = new Map<string, unknown>();
    let isAttached = true;
    const client = {
      cloudContainers: () => (isAttached ? JSON.stringify([{
        id: ID, owner: 'bob@local', role: 'reader', name: 'Документы команды', hasKey: true, headSeq: 0, epoch: 1,
        members: [],
      }]) : '[]'),
      cloudDomain: () => 'local',
      cloudIsAttached: () => false,
      cloudForget: () => {
        isAttached = false;
      },
    } as unknown as PvClient;
    const sync = createCloudSync({
      log: () => undefined,
      pv: () => ({ encodeMethodRequest: () => new Uint8Array() } as unknown as Protocol),
      client: () => client,
      isReady: () => true,
      needsLinking: () => false,
      self: () => 'alice@local',
      serverDomain: () => 'local',
      call: () => Promise.reject(new V2Error('ERROR_CODE_NOT_FOUND')),
      withNeeds: (fn) => Promise.resolve(fn()),
      refreshPeerLog: () => Promise.resolve(),
      persist: () => Promise.resolve(),
      loadRecord: <T>(key: string) => Promise.resolve(records.get(key) as T | undefined),
      saveRecord: (key, value) => {
        records.set(key, value);
        return Promise.resolve();
      },
      deleteRecord: () => Promise.resolve(),
      stateEntries: () => [{
        id: ID, domain: 'local', role: 'shared', owner: 'bob@local', status,
      }],
      recordEntry: () => undefined,
      deleteBlob: () => Promise.resolve(),
      onChanged: () => undefined,
    });
    return { ID, sync };
  }

  async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  it('keeps an accepted folder as «no access» until dismissed', async () => {
    const { ID, sync } = setup('accepted');
    sync.onEngineEvent(ID);
    await settle();
    expect(await sync.closedFolders()).toEqual([{ id: ID, name: 'Документы команды', owner: 'bob@local' }]);
    await sync.dismissClosed(ID);
    expect(await sync.closedFolders()).toEqual([]);
  });

  it('does not keep an unanswered invitation', async () => {
    const { ID, sync } = setup(undefined);
    sync.onEngineEvent(ID);
    await settle();
    expect(await sync.closedFolders()).toEqual([]);
  });
});
