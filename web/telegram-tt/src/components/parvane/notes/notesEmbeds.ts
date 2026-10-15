// Parvane, раздел «Знания»: встроенные файлы заметки (`![[имя]]`, `![](путь)`) — какой файл облака за ними стоит
// (этап 6 плана 15 окт 2026). Как в Obsidian: имя без папок ищется сначала рядом с заметкой, потом по всему
// личному диску (ближе к корню — раньше); путь с папками — по концу пути файла.

import type { CloudNode } from '../cloud/cloudModel';

import { drivePathOf } from './notesCanvasFiles';

export function resolveEmbed(nodes: CloudNode[], name: string, noteId?: string): CloudNode | undefined {
  const target = name.trim().replace(/^\/+/, '');
  if (!target) return undefined;
  const files = nodes.filter((node) => node.kind === 'file' && !node.trashed);
  const parent = noteId ? nodes.find((node) => node.id === noteId)?.parent : undefined;
  if (target.includes('/')) {
    const matches = files
      .map((node) => ({ node, path: drivePathOf(nodes, node.id) }))
      .filter(({ path }) => path === target || path.endsWith(`/${target}`))
      .sort((a, b) => a.path.length - b.path.length);
    return matches[0]?.node;
  }
  const named = files.filter((node) => node.name === target);
  if (!named.length) return undefined;
  const near = named.find((node) => (node.parent || undefined) === (parent || undefined));
  if (near) return near;
  return named
    .map((node) => ({ node, depth: drivePathOf(nodes, node.id).split('/').length }))
    .sort((a, b) => a.depth - b.depth)[0].node;
}
