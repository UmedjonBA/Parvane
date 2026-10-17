import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type { CloudNodeJson } from '../../../api/parvane/cloudDrive';
import type { ExportSnapshot } from './exportModel';
import type { ExportSource } from './exportRun';

import { DEFAULT_EXPORT_LABELS } from './exportModel';
import { cloudExportFiles, runDataExport, treeFilePaths } from './exportRun';
import { createZipWriter, ExportError } from './exportZip';

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]);

const snapshot: ExportSnapshot = {
  self: 'owl@example.test',
  selfName: 'Owl',
  chats: [
    {
      address: 'owl@example.test',
      kind: 'saved',
      title: 'owl',
      messages: [{
        uuid: 's1', from: 'owl@example.test', fromName: 'Owl', isOutgoing: true, ts: 1_700_000_000,
        content: { kind: 'text', text: 'note to self' },
      }],
    },
    {
      address: 'kestrel@example.test',
      kind: 'user',
      title: 'Kestrel',
      messages: [
        {
          uuid: 'k1', from: 'kestrel@example.test', fromName: 'Kestrel', isOutgoing: false, ts: 1_700_000_100,
          content: { kind: 'text', text: 'hello from the meadow' },
        },
        {
          uuid: 'k2', from: 'owl@example.test', fromName: 'Owl', isOutgoing: true, ts: 1_700_000_200,
          content: { kind: 'photo', file_id: 'photo-1', mime: 'image/jpeg' },
        },
        {
          uuid: 'k3', from: 'kestrel@example.test', fromName: 'Kestrel', isOutgoing: false, ts: 1_700_000_300,
          content: { kind: 'file', file_id: 'gone-1', mime: 'application/pdf', filename: 'map.pdf' },
        },
      ],
    },
  ],
  contacts: [{ address: 'kestrel@example.test', name: 'Kestrel', isExplicit: true }],
};

function node(fields: Partial<CloudNodeJson> & Pick<CloudNodeJson, 'id' | 'name'>): CloudNodeJson {
  return {
    kind: 'file',
    size: 3,
    mime: 'text/plain',
    mtime: 1_700_000_000_000,
    trashed: false,
    trashTop: false,
    trashedAt: 0,
    blob: fields.kind === 'folder' ? undefined : {
      fileId: `b-${fields.id}`,
      key: 'k',
      nonce: 'n',
      capability: 'c',
      size: 3,
      chunks: 1,
      mime: 'text/plain',
      uploader: 'owl',
    },
    ...fields,
  };
}

function fakeSource(overrides: Partial<ExportSource> = {}): ExportSource & { mediaCalls: string[] } {
  const mediaCalls: string[] = [];
  return {
    mediaCalls,
    snapshot: () => Promise.resolve(snapshot),
    media: (fileId) => {
      mediaCalls.push(fileId);
      return Promise.resolve(fileId === 'photo-1' ? new Blob([PHOTO], { type: 'image/jpeg' }) : undefined);
    },
    planner: () => Promise.resolve('{"tasks":[{"name":"Water the plants"}]}'),
    notes: () => Promise.resolve([{ path: 'Garden/Seeds.md', text: '# Seeds\n- basil' }]),
    cloudFiles: () => Promise.resolve([{
      container: 'root', node: 'n1', path: 'cloud/My files/readme.txt', size: 3,
    }]),
    cloudBlob: () => Promise.resolve(new Blob(['abc'])),
    ...overrides,
  };
}

async function unzip(blob: Blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

const decoder = new TextDecoder();

describe('runDataExport', () => {
  it('builds one archive with chats, media, planner, notes, contacts and index', async () => {
    const source = fakeSource();
    const stages: string[] = [];
    const result = await runDataExport({
      source,
      options: { includeMedia: true, includeCloud: false },
      labels: DEFAULT_EXPORT_LABELS,
      signal: new AbortController().signal,
      onProgress: (p) => { if (stages[stages.length - 1] !== p.stage) stages.push(p.stage); },
      now: new Date(2026, 2, 3),
    });
    expect(result.fileName).toBe('parvane-export-owl-2026-03-03.zip');
    expect(result).toMatchObject({
      chats: 2, messages: 4, media: 1, mediaFailed: 1, notes: 1, cloudFiles: 0,
    });
    expect(stages).toEqual(['prepare', 'chats', 'planner', 'notes', 'contacts', 'finishing']);
    const files = await unzip(result.blob);
    const names = Object.keys(files).sort();
    expect(names).toEqual([
      'chats/001-Saved Messages/messages.html',
      'chats/001-Saved Messages/messages.json',
      'chats/002-Kestrel/media/00002-photo-2.jpg',
      'chats/002-Kestrel/messages.html',
      'chats/002-Kestrel/messages.json',
      'contacts.json',
      'index.html',
      'notes/Garden/Seeds.md',
      'planner/planner.json',
    ]);
    expect(Array.from(files['chats/002-Kestrel/media/00002-photo-2.jpg'])).toEqual(Array.from(PHOTO));
    const chat = JSON.parse(decoder.decode(files['chats/002-Kestrel/messages.json']));
    expect(chat.messages.map((m: { text: string }) => m.text)).toEqual(['hello from the meadow', '', '']);
    expect(chat.messages[1].media.file).toBe('media/00002-photo-2.jpg');
    expect(chat.messages[2].media.status).toBe('unavailable');
    expect(JSON.parse(decoder.decode(files['planner/planner.json'])).tasks[0].name).toBe('Water the plants');
    expect(JSON.parse(decoder.decode(files['contacts.json'])).contacts[0].address).toBe('kestrel@example.test');
    expect(decoder.decode(files['index.html'])).toContain('chats/002-Kestrel/messages.html');
    expect(decoder.decode(files['notes/Garden/Seeds.md'])).toBe('# Seeds\n- basil');
  });

  it('skips media downloads when media are off and adds cloud files when asked', async () => {
    const source = fakeSource();
    const result = await runDataExport({
      source,
      options: { includeMedia: false, includeCloud: true },
      labels: DEFAULT_EXPORT_LABELS,
      signal: new AbortController().signal,
    });
    expect(source.mediaCalls).toEqual([]);
    const files = await unzip(result.blob);
    expect(decoder.decode(files['cloud/My files/readme.txt'])).toBe('abc');
    expect(Object.keys(files).some((name) => name.includes('/media/'))).toBe(false);
    expect(decoder.decode(files['index.html'])).toContain('cloud/My%20files/readme.txt');
  });

  it('stops with `canceled` when aborted mid-way', async () => {
    const abort = new AbortController();
    const source = fakeSource({
      media: () => {
        abort.abort();
        return Promise.resolve(new Blob([PHOTO]));
      },
    });
    await expect(runDataExport({
      source,
      options: { includeMedia: true, includeCloud: false },
      labels: DEFAULT_EXPORT_LABELS,
      signal: abort.signal,
    })).rejects.toMatchObject({ code: 'canceled' });
  });

  it('stops with `canceled` when aborted before start', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(runDataExport({
      source: fakeSource(),
      options: { includeMedia: true, includeCloud: true },
      labels: DEFAULT_EXPORT_LABELS,
      signal: abort.signal,
    })).rejects.toBeInstanceOf(ExportError);
  });

  it('fails without a snapshot', async () => {
    await expect(runDataExport({
      source: fakeSource({ snapshot: () => Promise.resolve(undefined) }),
      options: { includeMedia: true, includeCloud: false },
      labels: DEFAULT_EXPORT_LABELS,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('zip writer', () => {
  it('cancels while streaming a file', async () => {
    const abort = new AbortController();
    const writer = createZipWriter({ signal: abort.signal });
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 2) abort.abort();
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const blob = { size: 4096, stream: () => stream } as unknown as Blob;
    await expect(writer.addBlob('big.bin', blob)).rejects.toMatchObject({ code: 'canceled' });
    writer.abort();
  });

  it('rejects duplicate paths', async () => {
    const writer = createZipWriter();
    await writer.addText('a.txt', 'one');
    await expect(writer.addText('a.txt', 'two')).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('cloud paths', () => {
  const nodes = [
    node({ id: 'f1', kind: 'folder', name: 'Знания' }),
    node({ id: 'n1', parent: 'f1', name: 'Plan.md' }),
    node({ id: 'n2', parent: 'f1', name: 'plan.md' }),
    node({ id: 'n3', parent: 'f1', name: 'photo.jpg' }),
    node({ id: 'n4', parent: 'f1', name: 'old.md', trashed: true }),
    node({ id: 'n5', parent: 'f1', name: '.parvane-guide' }),
    node({ id: 'd1', kind: 'folder', parent: 'f1', name: 'Sub/dir' }),
    node({ id: 'n6', parent: 'd1', name: 'Deep.md' }),
    node({ id: 'r1', name: 'top.txt' }),
  ];

  it('walks a folder, skipping trash and service files', () => {
    const notes = treeFilePaths(nodes, '', 'f1', (n) => n.name.endsWith('.md'));
    expect(notes.map((n) => n.path)).toEqual(['Plan.md', 'Sub_dir/Deep.md', 'plan (2).md']);
  });

  it('puts each container in its own folder', () => {
    const files = cloudExportFiles([
      { id: 'root', name: 'My files', nodes },
      { id: 'c2', name: 'My files', nodes: [node({ id: 'x', name: 'x.txt' })] },
    ], 'Drive');
    expect(files.map((f) => f.path)).toEqual([
      'cloud/My files/top.txt',
      'cloud/My files/Знания/Plan.md',
      'cloud/My files/Знания/Sub_dir/Deep.md',
      'cloud/My files/Знания/photo.jpg',
      'cloud/My files/Знания/plan (2).md',
      'cloud/My files (2)/x.txt',
    ]);
  });
});
