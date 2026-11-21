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

const WIKI_EMBED_LINE = /^(\s*)!\[\[([^\]|]+)(\|[^\]]*)?\]\](\s*)$/;
const MD_EMBED_LINE = /^(\s*)!\[([^\]]*)\]\(([^)\s]+)((?:\s[^)]*)?)\)(\s*)$/;

function decodeTarget(target: string) {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

/** «Выбрать заново» у пропавшего файла: строки-вложения с именем `name` (`![[имя|подпись]]` и `![подпись](путь)`)
 * получают путь `path` выбранного файла диска; подпись и прочий текст не меняются. */
export function replaceEmbedTarget(text: string, name: string, path: string) {
  const target = name.trim();
  return text.split('\n').map((line) => {
    const wiki = WIKI_EMBED_LINE.exec(line);
    if (wiki) {
      return wiki[2].trim() === target ? `${wiki[1]}![[${path}${wiki[3] || ''}]]${wiki[4]}` : line;
    }
    const md = MD_EMBED_LINE.exec(line);
    if (md && decodeTarget(md[3]) === target) return `${md[1]}![${md[2]}](${encodeURI(path)}${md[4]})${md[5]}`;
    return line;
  }).join('\n');
}
