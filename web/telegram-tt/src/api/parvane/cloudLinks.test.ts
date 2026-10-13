import { describe, expect, it } from 'vitest';

import type { LinkManifestFile, LinkSourceNode } from './cloudLinks';

import { decryptBlob } from './blobcrypt';
import {
  base64UrlToBytes, buildLinkPlan, buildLinkTree, buildLinkUrl, buildManifest, bytesToBase64, bytesToBase64Url,
  isLinkDir, isLinkId, LINK_MAX_FILES, newLinkKey, openManifest, openOwnerRecord, parseLinkKey, parseManifest,
  runPool, sealManifest, sealOwnerRecord,
} from './cloudLinks';

// Parvane (spec 022): ссылка на файлы облака — план, список, запись владельца, адрес.

const LINK_ID = 'AbCdEfGhIjKlMnOpQrStUv';

function file(id: string, name: string, parent?: string, extra: Partial<LinkSourceNode> = {}): LinkSourceNode {
  return {
    id,
    kind: 'file',
    parent,
    name,
    size: 100,
    mime: 'text/plain',
    trashed: false,
    blob: {
      fileId: `blob-${id}`, key: `key-${id}`, nonce: `nonce-${id}`, capability: `cap-${id}`, size: 100, chunks: 1,
      mime: 'text/plain',
    },
    ...extra,
  };
}

function folder(id: string, name: string, parent?: string, trashed = false): LinkSourceNode {
  return {
    id, kind: 'folder', parent, name, size: 0, mime: '', trashed,
  };
}

const TREE: LinkSourceNode[] = [
  folder('d1', 'Отчёты'),
  file('f1', 'итог.pdf', 'd1'),
  folder('d2', 'Черновики', 'd1'),
  file('f2', 'план.md', 'd2'),
  folder('d3', 'Пустая', 'd1'),
  file('f3', 'старое.txt', 'd1', { trashed: true }),
  folder('d4', 'Удалённая', 'd1', true),
  file('f4', 'внутри удалённой.txt', 'd4', { trashed: true }),
  file('f5', '.parvane-guide.json', 'd1'),
  file('f6', 'рядом.txt'),
  folder('d5', 'Соседняя'),
  file('f7', 'чужое.txt', 'd5'),
];

function expectPlan(plan: ReturnType<typeof buildLinkPlan>) {
  if ('error' in plan) throw new Error(`план не собран: ${plan.error}`);
  return plan;
}

describe('ссылка облака: план', () => {
  it('файл — один элемент с именем файла', () => {
    const plan = expectPlan(buildLinkPlan(TREE, 'f6'));
    expect(plan).toMatchObject({ name: 'рядом.txt', kind: 'file', dirs: [], bytes: 100 });
    expect(plan.files.map((f) => f.path)).toEqual(['рядом.txt']);
  });

  it('папка — вложенные папки и файлы, без корзины, служебных файлов и соседей', () => {
    const plan = expectPlan(buildLinkPlan(TREE, 'd1'));
    expect(plan.name).toBe('Отчёты');
    expect(plan.kind).toBe('folder');
    expect(plan.dirs.sort()).toEqual(['Пустая', 'Черновики']);
    expect(plan.files.map((f) => f.path).sort()).toEqual(['Черновики/план.md', 'итог.pdf']);
    expect(plan.bytes).toBe(200);
  });

  it('пустая папка — ссылка без файлов', () => {
    const plan = expectPlan(buildLinkPlan(TREE, 'd3'));
    expect(plan.files).toEqual([]);
    expect(plan.dirs).toEqual([]);
  });

  it('весь контейнер (совместная папка) — верхний уровень под названием папки', () => {
    const plan = expectPlan(buildLinkPlan(TREE, undefined, 'Общая'));
    expect(plan.name).toBe('Общая');
    expect(plan.dirs).toContain('Отчёты/Черновики');
    expect(plan.files.map((f) => f.path)).toContain('Соседняя/чужое.txt');
    expect(plan.files.map((f) => f.path)).toContain('рядом.txt');
    expect(buildLinkPlan(TREE, undefined, '')).toEqual({ error: 'not-found' });
  });

  it('нет узла, узел в корзине — отказ', () => {
    expect(buildLinkPlan(TREE, 'нет')).toEqual({ error: 'not-found' });
    expect(buildLinkPlan(TREE, 'f3')).toEqual({ error: 'not-found' });
    expect(buildLinkPlan(TREE, 'd4')).toEqual({ error: 'not-found' });
  });

  it('предел 500 файлов проверяется до начала', () => {
    const many = [folder('big', 'Много')];
    for (let i = 0; i < LINK_MAX_FILES; i++) many.push(file(`n${i}`, `файл ${i}.txt`, 'big'));
    expect(expectPlan(buildLinkPlan(many, 'big')).files).toHaveLength(LINK_MAX_FILES);
    many.push(file('extra', 'лишний.txt', 'big'));
    expect(buildLinkPlan(many, 'big')).toEqual({ error: 'too-many' });
  });
});

describe('ссылка облака: список', () => {
  const plan = expectPlan(buildLinkPlan(TREE, 'd1'));
  const copies = new Map(plan.files.map(({ node }) => [
    node.id, { fileId: `copy-${node.id}`, blobSize: 124, chunks: 1 },
  ]));

  it('элементы по контракту: папки с dir, файлы с указателем на копию и ключами исходного блоба', () => {
    const manifest = buildManifest(plan, copies, 1791840000);
    expect(manifest).toMatchObject({
      v: 1, name: 'Отчёты', kind: 'folder', created: 1791840000,
    });
    expect(manifest.items.filter(isLinkDir).map((i) => i.path).sort()).toEqual(['Пустая', 'Черновики']);
    const item = manifest.items.find((i) => i.path === 'итог.pdf') as LinkManifestFile;
    expect(item).toEqual({
      path: 'итог.pdf',
      size: 100,
      mime: 'text/plain',
      fileId: 'copy-f1',
      key: 'key-f1',
      nonce: 'nonce-f1',
      chunks: 1,
      blobSize: 124,
    });
    // Секрет доступа исходного блоба и его идентификатор в список не попадают
    expect(JSON.stringify(manifest)).not.toContain('cap-');
    expect(JSON.stringify(manifest)).not.toContain('blob-f1');
  });

  it('шифруется ключом ссылки и читается только им', async () => {
    const key = newLinkKey();
    const manifest = buildManifest(plan, copies, 1791840000);
    const cipher = await sealManifest(manifest, key, LINK_ID);
    expect(new TextDecoder().decode(cipher.subarray(0, 4))).toBe('PVB2');
    expect(new TextDecoder('latin1').decode(cipher)).not.toContain('copy-f1');
    expect(await openManifest(cipher, key, LINK_ID)).toEqual(manifest);
    // Чужой ключ, чужая ссылка, порча — ничего
    expect(await openManifest(cipher, newLinkKey(), LINK_ID)).toBeUndefined();
    expect(await openManifest(cipher, key, 'ZZZZEfGhIjKlMnOpQrStUv')).toBeUndefined();
    const broken = cipher.slice();
    broken[broken.length - 1] ^= 1;
    expect(await openManifest(broken, key, LINK_ID)).toBeUndefined();
    expect(await openManifest(new Uint8Array(0), key, LINK_ID)).toBeUndefined();
  });

  it('nonce списка — первые 12 байт SHA-256("parvane-link-manifest" + link_id)', async () => {
    const key = newLinkKey();
    const cipher = await sealManifest(buildManifest(plan, copies, 1), key, LINK_ID);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`parvane-link-manifest${LINK_ID}`));
    const nonce = new Uint8Array(digest).slice(0, 12);
    const plain = await decryptBlob(cipher, bytesToBase64(key), bytesToBase64(nonce));
    expect(JSON.parse(new TextDecoder().decode(plain))).toMatchObject({ v: 1, name: 'Отчёты' });
  });

  it('разбор отвергает всё, что не по контракту', () => {
    const good = {
      v: 1,
      name: 'a',
      kind: 'file',
      created: 1,
      items: [{
        path: 'a', size: 1, mime: 'x/y', fileId: 'f', key: 'k', nonce: 'n', chunks: 1, blobSize: 25,
      }],
    };
    expect(parseManifest(JSON.stringify(good))).toBeDefined();
    const bad = (patch: object, itemPatch?: object) => JSON.stringify({
      ...good, ...(itemPatch ? { items: [{ ...good.items[0], ...itemPatch }] } : undefined), ...patch,
    });
    expect(parseManifest('не json')).toBeUndefined();
    expect(parseManifest(bad({ v: 2 }))).toBeUndefined();
    expect(parseManifest(bad({ kind: 'link' }))).toBeUndefined();
    expect(parseManifest(bad({ name: '' }))).toBeUndefined();
    expect(parseManifest(bad({ items: 'x' }))).toBeUndefined();
    expect(parseManifest(bad({}, { path: '../etc/passwd' }))).toBeUndefined();
    expect(parseManifest(bad({}, { path: '/abs' }))).toBeUndefined();
    expect(parseManifest(bad({}, { path: 'a//b' }))).toBeUndefined();
    expect(parseManifest(bad({}, { path: 'a\\b' }))).toBeUndefined();
    expect(parseManifest(bad({}, { size: -1 }))).toBeUndefined();
    expect(parseManifest(bad({}, { chunks: 0 }))).toBeUndefined();
    expect(parseManifest(bad({}, { fileId: '' }))).toBeUndefined();
    expect(parseManifest(bad({ items: [good.items[0], good.items[0]] }))).toBeUndefined();
  });

  it('дерево для показа: папки первыми, пустые папки остаются', () => {
    const tree = buildLinkTree(buildManifest(plan, copies, 1).items);
    expect(tree.map((n) => n.name)).toEqual(['Пустая', 'Черновики', 'итог.pdf']);
    expect(tree[1].children.map((n) => n.path)).toEqual(['Черновики/план.md']);
    expect(tree[0].children).toEqual([]);
    expect(tree[2].file?.fileId).toBe('copy-f1');
    // Папка без своей записи восстанавливается из пути файла
    const implied = buildLinkTree([{
      path: 'a/b/c.txt', size: 1, mime: '', fileId: 'f', key: '', nonce: '', chunks: 1, blobSize: 25,
    }]);
    expect(implied[0].name).toBe('a');
    expect(implied[0].children[0].children[0].name).toBe('c.txt');
  });
});

describe('ссылка облака: запись владельца и адрес', () => {
  it('u32 BE эпоха | шифртекст под ключом личного диска этой эпохи', async () => {
    const driveKey = crypto.getRandomValues(new Uint8Array(32));
    const linkKey = bytesToBase64Url(newLinkKey());
    const record = {
      name: 'Отчёты', kind: 'folder' as const, key: linkKey, epoch: 3, source: { container: 'c1', node: 'd1' },
    };
    const wire = await sealOwnerRecord(record, driveKey, LINK_ID);
    expect(Array.from(wire.subarray(0, 4))).toEqual([0, 0, 0, 3]);
    expect(wire.length).toBeLessThan(4096);
    const keys = new Map([[2, bytesToBase64(newLinkKey())], [3, bytesToBase64(driveKey)]]);
    expect(await openOwnerRecord(wire, keys, LINK_ID)).toEqual(record);
    // Открытый текст — JSON контракта
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`parvane-link-owner${LINK_ID}`));
    const plain = await decryptBlob(
      wire.subarray(4), bytesToBase64(driveKey), bytesToBase64(new Uint8Array(digest).slice(0, 12)),
    );
    expect(JSON.parse(new TextDecoder().decode(plain))).toMatchObject({
      v: 1, name: 'Отчёты', kind: 'folder', key: linkKey, epoch: 3,
    });
    // Нет ключа эпохи, чужая ссылка, обрезанная запись
    expect(await openOwnerRecord(wire, new Map([[2, bytesToBase64(driveKey)]]), LINK_ID)).toBeUndefined();
    expect(await openOwnerRecord(wire, keys, 'ZZZZEfGhIjKlMnOpQrStUv')).toBeUndefined();
    expect(await openOwnerRecord(wire.subarray(0, 4), keys, LINK_ID)).toBeUndefined();
  });

  it('запись с самым длинным названием укладывается в предел сервера', async () => {
    const wire = await sealOwnerRecord({
      name: 'я'.repeat(127), kind: 'file', key: bytesToBase64Url(newLinkKey()), epoch: 1,
      source: { container: 'a'.repeat(32), node: 'b'.repeat(32) },
    }, newLinkKey(), LINK_ID);
    expect(wire.length).toBeLessThan(4096);
  });

  it('адрес: ключ только во фрагменте', () => {
    const key = newLinkKey();
    const url = buildLinkUrl('https://parvane.example:20443/', LINK_ID, bytesToBase64Url(key));
    expect(url).toBe(`https://parvane.example:20443/s/${LINK_ID}#k=${bytesToBase64Url(key)}`);
    const parsed = new URL(url);
    expect(parsed.pathname + parsed.search).not.toContain(bytesToBase64Url(key));
    expect(Array.from(parseLinkKey(parsed.hash)!)).toEqual(Array.from(key));
  });

  it('ключ из фрагмента: только 32 байта base64url', () => {
    expect(parseLinkKey('')).toBeUndefined();
    expect(parseLinkKey('#k=')).toBeUndefined();
    expect(parseLinkKey('#k=short')).toBeUndefined();
    expect(parseLinkKey(`#k=${'A'.repeat(44)}`)).toBeUndefined();
    expect(parseLinkKey(`#k=${'!'.repeat(43)}`)).toBeUndefined();
    expect(parseLinkKey(`#x=${'A'.repeat(43)}`)).toBeUndefined();
    expect(parseLinkKey(`#k=${'A'.repeat(43)}`)).toHaveLength(32);
    expect(base64UrlToBytes('%%%')).toBeUndefined();
  });

  it('идентификатор ссылки: 16–32 знака base64url', () => {
    expect(isLinkId(LINK_ID)).toBe(true);
    expect(isLinkId('short')).toBe(false);
    expect(isLinkId(`${LINK_ID}/../x`)).toBe(false);
    expect(isLinkId('A'.repeat(33))).toBe(false);
  });
});

describe('ссылка облака: очередь копий', () => {
  it('не больше заданного числа одновременно, все элементы обработаны', async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool(Array.from({ length: 20 }, (_, i) => i), 4, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
      seen.push(item);
      running -= 1;
    });
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('первая ошибка останавливает остальных и возвращается вызывающему', async () => {
    let started = 0;
    await expect(runPool([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
      started += 1;
      await Promise.resolve();
      if (item === 2) throw new Error('сбой');
    })).rejects.toThrow('сбой');
    expect(started).toBeLessThan(8);
    await expect(runPool([], 3, () => Promise.reject(new Error('не вызывается')))).resolves.toBeUndefined();
  });
});
