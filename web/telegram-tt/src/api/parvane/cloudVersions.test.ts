import { describe, expect, it } from 'vitest';

import type { CloudBlobInfo, CloudNodeJson } from './cloudDrive';
import type { CloudSync } from './v2/cloud';

import { createCloudReceiver, receivedNodeId } from './cloudReceived';
import { createCloudVersions, pickCloudVersion } from './cloudVersions';

// CLOUD-3: выбор версии узла, возврат её текущей (свой блоб — той же записью, чужой — копией) и копия присланного
// собеседником файла в корень диска с `from`; данные выдуманные

function blob(fileId: string, uploader: string): CloudBlobInfo {
  return {
    fileId, key: 'a2V5', nonce: 'bm9uY2U=', capability: 'Y2Fw', size: 4, chunks: 1, mime: 'text/markdown', uploader,
  };
}

const NODE: CloudNodeJson = {
  id: '11'.repeat(16),
  kind: 'file',
  name: 'план.md',
  size: 4,
  mime: 'text/markdown',
  mtime: 300,
  trashed: false,
  trashTop: false,
  trashedAt: 0,
  blob: blob('cur', 'alice@local'),
  versions: [
    {
      blob: blob('old', 'alice@local'), mtime: 200, size: 3, device: 'd1',
    },
    {
      blob: blob('bobs', 'bob@local'), mtime: 100, size: 2, device: 'd9',
    },
  ],
};

function fakeCloud(applied: unknown[][], tree?: { nodes: { id: string }[] }) {
  return {
    apply: (container: string, ops: unknown[]) => {
      applied.push([container, ...ops]);
      return Promise.resolve(container);
    },
    containers: () => [{ id: 'root-id', kind: 'root' }],
    stateJson: () => (tree ? JSON.stringify(tree) : undefined),
  } as unknown as CloudSync;
}

describe('cloud versions', () => {
  it('picks the current or an earlier version', () => {
    expect(pickCloudVersion(NODE, 'cur')).toBe(NODE);
    expect(pickCloudVersion(NODE, undefined)).toBe(NODE);
    const old = pickCloudVersion(NODE, 'old')!;
    expect([old.blob!.fileId, old.size, old.mtime, old.id]).toEqual(['old', 3, 200, NODE.id]);
    expect(pickCloudVersion(NODE, 'missing')).toBeUndefined();
  });

  it('restores an own version by the same blob and a foreign one by a copy', async () => {
    const applied: unknown[][] = [];
    const copies: string[] = [];
    const versions = createCloudVersions({
      log: () => undefined,
      self: () => 'alice@local',
      cloud: () => fakeCloud(applied),
      findNode: () => NODE,
      copyBlob: (fileId) => {
        copies.push(fileId);
        return Promise.resolve({ fileId: 'copy-1', capability: 'bmV3' });
      },
      errorOf: () => 'rejected',
    });
    expect(await versions.parvaneCloudRestoreVersion({ container: 'c', node: NODE.id, fileId: 'old' }))
      .toEqual({ ok: true });
    expect(await versions.parvaneCloudRestoreVersion({ container: 'c', node: NODE.id, fileId: 'bobs' }))
      .toEqual({ ok: true });
    expect(copies).toEqual(['bobs']);
    const [own, foreign] = applied.map((a) => a[1] as { op: string; keep: boolean; blob: CloudBlobInfo });
    expect([own.op, own.keep, own.blob.fileId, own.blob.uploader]).toEqual(['setBlob', true, 'old', 'alice@local']);
    expect([foreign.blob.fileId, foreign.blob.capability, foreign.blob.uploader])
      .toEqual(['copy-1', 'bmV3', 'alice@local']);
    expect((await versions.parvaneCloudRestoreVersion({ container: 'c', node: NODE.id, fileId: 'nope' })).ok)
      .toBe(false);
  });
});

describe('cloud received copies', () => {
  const wire = {
    kind: 'file' as const,
    file_id: 'media-1',
    file_key: 'a2V5',
    file_nonce: 'bm9uY2U=',
    capability: 'Y2Fw',
    filename: 'регламент/обновлений.md',
    mime: 'text/markdown',
    size_bytes: 4,
    to_files: true,
  };

  function receiver(applied: unknown[][], calls: unknown[], tree?: { nodes: { id: string }[] }) {
    const saved = new Map<string, unknown>();
    return createCloudReceiver({
      log: () => undefined,
      cloud: () => fakeCloud(applied, tree),
      blobCall: <T, >(method: string, request: unknown) => {
        calls.push([method, request]);
        return Promise.resolve({ file_id: 'drive-1', chunks: 1 } as T);
      },
      downloadBlobCap: (fileId, capability, first) => {
        calls.push(['download', { fileId, capability, first }]);
        return Promise.resolve({ size: 40, chunks: 1, parts: new Map([[0, new Uint8Array(40)]]) });
      },
      setBlobDomain: (fileId, domain) => {
        calls.push(['domain', { fileId, domain }]);
      },
      serverDomain: () => 'local',
      loadRecord: <T, >(key: string) => Promise.resolve(saved.get(key) as T | undefined),
      saveRecord: (key, value) => {
        saved.set(key, value);
        return Promise.resolve();
      },
    });
  }

  it('copies the blob into the drive root with the sender once per message', async () => {
    const applied: unknown[][] = [];
    const calls: unknown[] = [];
    const { receive } = receiver(applied, calls);
    const args = {
      wire, from: 'aliya@local', opId: 'op-1', self: 'bob@local',
    };
    await receive(args);
    await receive(args);
    expect(calls).toHaveLength(1);
    expect((calls[0] as [string, { bucket: string }])[1].bucket).toBe('BLOB_BUCKET_DRIVE');
    const [container, op] = applied[0] as [string, {
      id: string; from: string; name: string; parent?: string; blob: CloudBlobInfo;
    }];
    expect(container).toBe('root');
    expect(op.id).toBe(await receivedNodeId('op-1'));
    expect(op.id).toMatch(/^[0-9a-f]{32}$/);
    expect([op.from, op.name, op.parent, op.blob.fileId, op.blob.uploader])
      .toEqual(['aliya@local', 'регламент_обновлений.md', undefined, 'drive-1', 'bob@local']);
  });

  it('skips a node another device already made', async () => {
    const applied: unknown[][] = [];
    const calls: unknown[] = [];
    const id = await receivedNodeId('op-2');
    await receiver(applied, calls, { nodes: [{ id }] }).receive({
      wire, from: 'aliya@local', opId: 'op-2', self: 'bob@local',
    });
    expect([applied.length, calls.length]).toEqual([0, 0]);
  });

  it('relays a blob of another server through the device into the own drive', async () => {
    const applied: unknown[][] = [];
    const calls: [string, Record<string, unknown>][] = [];
    await receiver(applied, calls).receive({
      wire: { ...wire, blob_domain: 'far.example' }, from: 'aliya@far.example', opId: 'op-3', self: 'bob@local',
    });
    expect(calls.map((c) => c[0])).toEqual([
      'domain', 'download', 'cloud.blob.upload_chunk', 'cloud.blob.upload_complete',
    ]);
    expect(calls[0][1]).toEqual({ fileId: 'media-1', domain: 'far.example' });
    expect(calls[1][1]).toEqual({ fileId: 'media-1', capability: 'Y2Fw', first: 0 });
    expect(calls.some((c) => c[0] === 'cloud.blob.copy')).toBe(false);
    const [, op] = applied[0] as [string, { from: string; blob: CloudBlobInfo }];
    expect([op.from, op.blob.fileId, op.blob.key, op.blob.uploader, op.blob.chunks])
      .toEqual(['aliya@far.example', 'drive-1', 'a2V5', 'bob@local', 1]);
    expect(op.blob.capability).not.toBe('Y2Fw');
  });
});
