// Parvane: общий разбор Markdown заметок «Знаний» и статьи в чате (ARTICLE-1) — один разбор и один показ
// (этап 6 плана 15 окт 2026). Блоки: заголовки, абзацы, списки (с галочками и нумерованные, вложенные), цитаты,
// код, черта, таблицы, встроенные файлы `![[файл]]` / `![подпись](файл)`; в строке — жирный, курсив,
// зачёркнутый, код, ссылки http(s)/mailto, [[заметки]], #теги. У блоков и пунктов — номер строки исходного
// текста: заметка по нему отмечает пункт выполненным.

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'bold' | 'italic' | 'strike' | 'code' | 'tag'; text: string }
  | { type: 'note'; text: string; target: string }
  | { type: 'link'; text: string; url: string };

export type MdListItem = { text: string; depth: number; isChecked?: boolean; line: number };
export type MdAlign = 'left' | 'center' | 'right' | undefined;

// Встроенный файл: `name` — имя (путь) файла облака; внешний адрес (`url`) не загружается — показывается ссылкой
export type MdEmbed = { type: 'embed'; name: string; alt?: string; url?: string; line: number };

export type MdBlock = (
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; isOrdered: boolean; items: MdListItem[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'table'; header: string[]; align: MdAlign[]; rows: string[][] }
) & { line: number } | MdEmbed;

const FENCE = /^\s*```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const TASK = /^(\s*)[-*+] \[( |x|X)\](?: (.*))?$/;
const BULLET = /^(\s*)[-*+] (.*)$/;
const ORDERED = /^(\s*)\d+[.)] (.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const EMBED = /^\s*!(?:\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|\[([^\]]*)\]\(([^)\s]+)[^)]*\))\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FRONT_MATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;
const INLINE = new RegExp([
  '\\*\\*[^*\\n]+\\*\\*',
  '~~[^~\\n]+~~',
  '`[^`\\n]+`',
  '\\[\\[[^\\]\\n]+\\]\\]',
  '\\[[^\\]\\n]+\\]\\([^)\\s]+\\)',
  // Курсив и тег — с начала строки либо после пробела (пробел попадает в найденное: просмотра назад нет
  // в старых Safari)
  '(?:^|\\s)[*_][^*_\\n]+[*_]',
  '(?:^|\\s)#[\\p{L}\\d_/-]+',
].map((part) => `(?:${part})`).join('|'), 'u');
const SAFE_URL = /^(?:https?:|mailto:)/i;
const WEB_URL = /^https?:\/\//i;
// Отступ вложенного пункта: два пробела либо табуляция на уровень
const INDENT_STEP = 2;

/** Блоки текста. Первый заголовок, повторяющий название, пропускается: название стоит над текстом */
export function parseMarkdown(markdown: string, title = ''): MdBlock[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const frontMatter = FRONT_MATTER.exec(normalized)?.[0] || '';
  // Номера строк — по исходному тексту: свойства в начале заметки тоже строки
  const offset = frontMatter ? frontMatter.split('\n').length - (frontMatter.endsWith('\n') ? 1 : 0) : 0;
  const lines = normalized.slice(frontMatter.length).split('\n');
  const blocks: MdBlock[] = [];
  const ownTitle = title.trim().toLowerCase();
  let paragraph: string[] = [];
  let paragraphLine = 0;
  let code: string[] | undefined;
  let codeLine = 0;
  let quote: string[] = [];
  let quoteLine = 0;
  let list: Extract<MdBlock, { type: 'list' }> | undefined;

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n'), line: paragraphLine });
    if (quote.length) blocks.push({ type: 'quote', text: quote.join('\n'), line: quoteLine });
    if (list) blocks.push(list);
    paragraph = [];
    quote = [];
    list = undefined;
  };
  const addItem = (isOrdered: boolean, item: MdListItem) => {
    if (paragraph.length || quote.length || (list && list.isOrdered !== isOrdered)) flush();
    list ||= {
      type: 'list', isOrdered, items: [], line: item.line,
    };
    list.items.push(item);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = i + offset;
    if (code) {
      if (FENCE.test(line)) {
        blocks.push({ type: 'code', text: code.join('\n'), line: codeLine });
        code = undefined;
      } else {
        code.push(line);
      }
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      code = [];
      codeLine = at;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const text = heading[2].trim();
      if (!blocks.length && text.toLowerCase() === ownTitle) continue;
      blocks.push({
        type: 'heading', level: heading[1].length as 1 | 2 | 3, text, line: at,
      });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: 'rule', line: at });
      continue;
    }
    const embed = EMBED.exec(line);
    if (embed) {
      flush();
      blocks.push(embedOf(embed, at));
      continue;
    }
    if (line.includes('|') && TABLE_SEPARATOR.test(lines[i + 1] || '') && !paragraph.length) {
      flush();
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      let next = i + 2;
      while (next < lines.length && lines[next].includes('|') && lines[next].trim()) {
        const cells = splitRow(lines[next]);
        rows.push(header.map((_, n) => cells[n] || ''));
        next++;
      }
      blocks.push({
        type: 'table', header, align: header.map((_, n) => align[n]), rows, line: at,
      });
      i = next - 1;
      continue;
    }
    const task = TASK.exec(line);
    if (task) {
      addItem(false, {
        text: task[3] || '', depth: depthOf(task[1]), isChecked: task[2] !== ' ', line: at,
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      addItem(false, { text: bullet[2], depth: depthOf(bullet[1]), line: at });
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      addItem(true, { text: ordered[2], depth: depthOf(ordered[1]), line: at });
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      if (paragraph.length || list) flush();
      if (!quote.length) quoteLine = at;
      quote.push(quoted[1]);
      continue;
    }
    if (quote.length || list) flush();
    if (!paragraph.length) paragraphLine = at;
    paragraph.push(line);
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n'), line: codeLine });
  flush();
  return blocks;
}

/** Строка → куски с разметкой. Ссылка только http(s)/mailto, иначе остаётся текстом */
export function parseInline(text: string): MdInline[] {
  const parts: MdInline[] = [];
  let rest = text;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) {
      parts.push({ type: 'text', text: rest });
      break;
    }
    const space = /^\s/.test(match[0]) ? match[0][0] : '';
    const before = rest.slice(0, match.index) + space;
    if (before) parts.push({ type: 'text', text: before });
    parts.push(inlineOf(match[0].slice(space.length)));
    rest = rest.slice(match.index + match[0].length);
  }
  return mergeText(parts);
}

/** Имена встроенных файлов облака (без внешних адресов), по порядку и без повторов */
export function embedNames(markdown: string) {
  const names: string[] = [];
  parseMarkdown(markdown).forEach((block) => {
    if (block.type === 'embed' && !block.url && !names.includes(block.name)) names.push(block.name);
  });
  return names;
}

/** Последняя часть пути встроенного файла: под ней файл лежит в статье и в облаке получателя */
export function embedBaseName(name: string) {
  const parts = name.split('/').filter(Boolean);
  return parts[parts.length - 1] || name;
}

/** Переписать цели встроенных файлов (`![[старое]]` → `![[новое]]`); прочий текст не меняется */
export function renameEmbeds(markdown: string, rename: Map<string, string>) {
  return markdown.split('\n').map((line) => {
    const embed = EMBED.exec(line);
    if (!embed) return line;
    const block = embedOf(embed, 0);
    const next = !block.url && rename.get(block.name);
    if (!next || next === block.name) return line;
    return embed[1] !== undefined
      ? `![[${next}${embed[2] !== undefined ? `|${embed[2]}` : ''}]]`
      : `![${embed[3] || ''}](${encodeURI(next)})`;
  }).join('\n');
}

function embedOf(match: RegExpExecArray, line: number): MdEmbed {
  if (match[1] !== undefined) {
    return {
      type: 'embed', name: match[1].trim(), alt: match[2]?.trim() || undefined, line,
    };
  }
  const target = match[4];
  const alt = match[3]?.trim() || undefined;
  if (WEB_URL.test(target)) {
    return {
      type: 'embed', name: target, alt, url: target, line,
    };
  }
  let name = target;
  try {
    name = decodeURI(target);
  } catch {
    // неверная %-последовательность — имя как написано
  }
  return {
    type: 'embed', name: name.trim(), alt, line,
  };
}

// Ячейки строки таблицы; `\|` — знак внутри ячейки (без просмотра назад: его нет в старых Safari)
function splitRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (trimmed[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += trimmed[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): MdAlign {
  const isLeft = cell.startsWith(':');
  const isRight = cell.endsWith(':');
  if (isLeft && isRight) return 'center';
  if (isRight) return 'right';
  return isLeft ? 'left' : undefined;
}

function inlineOf(token: string): MdInline {
  if (token.startsWith('**')) return { type: 'bold', text: token.slice(2, -2) };
  if (token.startsWith('~~')) return { type: 'strike', text: token.slice(2, -2) };
  if (token.startsWith('`')) return { type: 'code', text: token.slice(1, -1) };
  if (token.startsWith('[[')) {
    const [target, alias] = token.slice(2, -2).split('|');
    return { type: 'note', text: (alias || target).trim(), target: target.trim() };
  }
  if (token.startsWith('[')) {
    const split = token.indexOf('](');
    const label = token.slice(1, split);
    const url = token.slice(split + 2, -1);
    return SAFE_URL.test(url) ? { type: 'link', text: label, url } : { type: 'text', text: label };
  }
  if (token.startsWith('#')) return { type: 'tag', text: token };
  return { type: 'italic', text: token.slice(1, -1) };
}

function mergeText(parts: MdInline[]) {
  return parts.reduce<MdInline[]>((out, part) => {
    const last = out[out.length - 1];
    if (part.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', text: last.text + part.text };
    } else {
      out.push(part);
    }
    return out;
  }, []);
}

function depthOf(indent: string) {
  return Math.floor(indent.replace(/\t/g, ' '.repeat(INDENT_STEP)).length / INDENT_STEP);
}
