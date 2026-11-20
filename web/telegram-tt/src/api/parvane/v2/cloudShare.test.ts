import { describe, expect, it } from 'vitest';

import type { Protocol, PvClient } from './engine';

import { createCloudSync } from './cloud';

// Владелец снова приглашает участника, отказавшегося после последнего опроса журнала грантов: запись «leave» уже
// на сервере, а движок ещё числит участника с той же ролью. Без догона журнала `cloudGrant` счёл бы приглашение
// повтором и ничего не отправил (приглашение после отказа не доходило)
describe('cloud share after decline', () => {
  it('catches up the grant log before granting', async () => {
    const ID = 'ab'.repeat(16);
    const BOB = 'bob@local';
    const calls: string[] = [];
    let version = 2;
    let members = [{ user: BOB, role: 'reader' }];
    const client = {
      cloudContainers: () => JSON.stringify([{
        id: ID, owner: 'alice@local', role: 'owner', name: 'Отказ', hasKey: true, headSeq: 0, epoch: 1,
        grantVersion: version, members,
      }]),
      cloudDomain: () => 'local',
      cloudIsAttached: () => true,
      cloudHasKey: () => true,
      cloudGrantVersion: () => version,
      cloudIngestGrants: () => {
        calls.push('ingestGrants');
        // На сервере — запись выхода Боба
        version = 3;
        members = [];
      },
      cloudRotate: () => {
        calls.push('rotate');
        return [{ chan: 'id', method: 'domain.key.rotate', body: new Uint8Array() }];
      },
      cloudGrant: () => {
        calls.push(members.length ? 'grant-noop' : 'grant');
        return members.length ? [] : [{ chan: 'id', method: 'domain.grant.set', body: new Uint8Array() }];
      },
    } as unknown as PvClient;
    const pv = { encodeMethodRequest: () => new Uint8Array() } as unknown as Protocol;
    const sync = createCloudSync({
      log: () => undefined,
      pv: () => pv,
      client: () => client,
      isReady: () => true,
      needsLinking: () => false,
      self: () => 'alice@local',
      serverDomain: () => 'local',
      call: (chan, method) => {
        calls.push(method);
        return Promise.resolve(new Uint8Array());
      },
      withNeeds: (fn) => Promise.resolve(fn()),
      refreshPeerLog: () => Promise.resolve(),
      persist: () => Promise.resolve(),
      loadRecord: () => Promise.resolve(undefined),
      saveRecord: () => Promise.resolve(),
      deleteRecord: () => Promise.resolve(),
      stateEntries: () => [],
      recordEntry: () => undefined,
      deleteBlob: () => Promise.resolve(),
      onChanged: () => undefined,
    });
    await sync.share(ID, BOB, 'reader', 'Приглашение');
    expect(calls).toEqual([
      'domain.grant.list', 'ingestGrants', 'rotate', 'domain.key.rotate', 'grant', 'domain.grant.set',
    ]);
  });
});
