// Parvane: общий разбор Markdown заметок «Знаний» и статьи в чате (ARTICLE-1) — один разбор и один показ
// (этап 6 плана 15 окт 2026; доработка 6 ноя 2026 по тестовому файлу пользователя). Тот же разбор повторяет ядро
// desktop/android (`parvane-core/src/sections/markdown.cpp`); сверка — общий файл `conformance/markdown/`.
//
// Блоки: заголовки H1–H6 (закрывающие `#`, свой id `{#id}`), абзацы, списки (галочки, нумерация с первого номера,
// вложенность по отступу, абзацы/код/цитаты внутри пункта), цитаты с любыми блоками внутри и вложенные, callouts
// (`> [!NOTE]`, `> [!info]-`), код ``` и ~~~ (язык из info string), черта (`---`, `* * *`), таблицы, встроенные
// файлы `![[файл]]` / `![подпись](файл)`; комментарии `<!-- -->` и `%% %%` скрыты.
// В строке — куски с набором начертаний (жирный, курсив, зачёркнутый, подчёркнутый, выделение `==`, верхний/нижний
// индекс, код), ссылки http(s)/mailto и якоря `#раздел`, голые адреса, `<адрес>`, [[заметки]], #теги, экранирование
// `\*`, HTML-сущности и разрешённые теги (`<br> <u> <mark> <sub> <sup> <kbd> <b> <i> <s>`). Прочий HTML — текстом.
// У блоков и пунктов — номер строки исходного текста: заметка по нему отмечает пункт выполненным.

export const MD_BOLD = 1;
export const MD_ITALIC = 2;
export const MD_STRIKE = 4;
export const MD_UNDERLINE = 8;
export const MD_MARK = 16;
export const MD_SUB = 32;
export const MD_SUP = 64;
export const MD_CODE = 128;

// Кусок строки: `style` — набор MD_* (нет — обычный); `link` — url http(s)/mailto либо `#якорь`
export type MdInline = {
  type: 'text' | 'tag' | 'note' | 'link';
  text: string;
  target?: string;
  url?: string;
  style?: number;
};

export type MdListItem = {
  text: string;
  depth: number;
  isChecked?: boolean;
  // Номер пункта нумерованного списка; нет — маркер-точка
  number?: number;
  // Блоки внутри пункта (второй абзац, код, цитата — строки с отступом пункта)
  blocks?: MdBlock[];
  line: number;
};
export type MdAlign = 'left' | 'center' | 'right' | undefined;
export type MdCallout = { kind: string; title: string; fold?: 'open' | 'closed' };

// Встроенный файл: `name` — имя (путь) файла облака; внешний адрес (`url`) не загружается — показывается ссылкой
export type MdEmbed = { type: 'embed'; name: string; alt?: string; url?: string; line: number };

export type MdBlock = (
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; id: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; isOrdered: boolean; items: MdListItem[] }
  | { type: 'quote'; blocks: MdBlock[]; callout?: MdCallout }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'rule' }
  | { type: 'table'; header: string[]; align: MdAlign[]; rows: string[][] }
) & { line: number } | MdEmbed;

const EMBED = /^\s*!(?:\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|\[([^\]]*)\]\(([^)\s]+)(?:\s[^)]*)?\))\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FRONT_MATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;
const SAFE_URL = /^(?:https?:|mailto:)/i;
const WEB_URL = /^https?:\/\//i;
// Отступ вложенного пункта: два пробела либо табуляция на уровень
const INDENT_STEP = 2;
const CODE_INDENT = 4;
// Глубина вложенности (цитаты, пункты, начертания): глубже — текстом
const MAX_DEPTH = 12;
// Сколько знаков ищется закрывающая пара начертания / ссылки (разбор не квадратичен на непарных знаках)
const SCAN_LIMIT = 2000;
const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_CELLS = 2000;

/** Блоки текста. Первый заголовок, повторяющий название, пропускается: название стоит над текстом */
export function parseMarkdown(markdown: string, title = ''): MdBlock[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const frontMatter = FRONT_MATTER.exec(normalized)?.[0] || '';
  // Номера строк — по исходному тексту: свойства в начале заметки тоже строки
  const offset = frontMatter ? frontMatter.split('\n').length - (frontMatter.endsWith('\n') ? 1 : 0) : 0;
  const lines = normalized.slice(frontMatter.length).split('\n');
  const blocks = parseBlocks(lines, lines.map((_, i) => i + offset), 0);
  const first = blocks[0];
  if (first?.type === 'heading' && title.trim()
    && inlineText(first.text).trim().toLowerCase() === title.trim().toLowerCase()) {
    blocks.shift();
  }
  assignIds(blocks, new Map());
  return blocks;
}

// ── блоки ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Fence = { char: string; length: number; indent: number; lang?: string };

// `tab` — колонок на табуляцию: в списках INDENT_STEP (уровень), в коде с отступом — CODE_INDENT (как CommonMark)
function columnsOf(indent: string, tab = INDENT_STEP) {
  let n = 0;
  for (const c of indent) n += c === '\t' ? tab : 1;
  return n;
}

function leadingOf(line: string) {
  return /^[ \t]*/.exec(line)![0];
}

/** Убрать до `columns` колонок отступа (табуляция — INDENT_STEP колонок) */
function dedent(line: string, columns: number, tab = INDENT_STEP) {
  let n = 0;
  let i = 0;
  while (i < line.length && n < columns && (line[i] === ' ' || line[i] === '\t')) {
    n += line[i] === '\t' ? tab : 1;
    i++;
  }
  return line.slice(i);
}

function fenceOpen(line: string): Fence | undefined {
  const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const info = match[3].trim();
  if (match[2][0] === '`' && info.includes('`')) return undefined;
  const lang = /^[^\s{]+/.exec(info.replace(/^\{?\.?/, ''))?.[0].toLowerCase();
  return {
    char: match[2][0], length: match[2].length, indent: columnsOf(match[1]), lang: lang || undefined,
  };
}

function isFenceClose(line: string, fence: Fence) {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.length);
}

function headingOf(line: string) {
  const match = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
  if (!match) return undefined;
  let text = match[2].replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
  let id: string | undefined;
  const custom = /[ \t]*\{#([\p{L}\p{N}_-]{1,100})\}$/u.exec(text);
  if (custom) {
    id = custom[1];
    text = text.slice(0, custom.index).trim();
  }
  return { level: match[1].length as 1 | 2 | 3 | 4 | 5 | 6, text, id };
}

function isRule(line: string) {
  return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

type ItemMatch = {
  indent: number; contentColumn: number; number?: number; text: string; isChecked?: boolean;
};

function itemOf(line: string): ItemMatch | undefined {
  const match = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/.exec(line);
  if (!match) return undefined;
  const indent = columnsOf(match[1]);
  const spaces = match[3] ? columnsOf(match[3]) : 1;
  const contentColumn = indent + match[2].length + (spaces > 4 ? 1 : spaces);
  let text = (match[4] || '').trimEnd();
  let isChecked: boolean | undefined;
  const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(text);
  if (task) {
    isChecked = task[1] !== ' ';
    text = task[2] || '';
  }
  const number = /\d/.test(match[2][0]) ? Number(match[2].slice(0, -1)) : undefined;
  return {
    indent, contentColumn, number, text, isChecked,
  };
}

function quoteOf(line: string) {
  const match = /^ {0,3}>(.*)$/.exec(line);
  if (!match) return undefined;
  const rest = match[1];
  return rest.startsWith(' ') || rest.startsWith('\t') ? rest.slice(1) : rest;
}

function isCommentStart(line: string) {
  return line.trimStart().startsWith('<!--');
}

// Строка начинает блок (прерывает абзац и ленивое продолжение)
function startsBlock(line: string) {
  return Boolean(headingOf(line) || fenceOpen(line) || isRule(line) || itemOf(line) || quoteOf(line) !== undefined
    || EMBED.test(line) || isCommentStart(line));
}

function parseBlocks(lines: string[], lineNos: number[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let paragraphLine = 0;

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n'), line: paragraphLine });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const at = lineNos[i];
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    // HTML-комментарий отдельной строкой либо на несколько строк — скрыт
    if (isCommentStart(line)) {
      const start = line.indexOf('<!--');
      const end = line.indexOf('-->', start + 4);
      if (end < 0) {
        flush();
        i++;
        while (i < lines.length && !lines[i].includes('-->')) i++;
        i++;
        continue;
      }
      if (!line.slice(end + 3).trim()) {
        flush();
        i++;
        continue;
      }
    }
    // Комментарий Obsidian `%%` на несколько строк — скрыт
    const trimmed = line.trim();
    if (trimmed.startsWith('%%')) {
      if (!trimmed.slice(2).includes('%%')) {
        flush();
        i++;
        while (i < lines.length && !lines[i].includes('%%')) i++;
        i++;
        continue;
      }
      if (/^%%.*%%$/.test(trimmed)) {
        flush();
        i++;
        continue;
      }
    }
    // Код с отступом в 4 колонки (не продолжение абзаца)
    if (!paragraph.length && columnsOf(leadingOf(line), CODE_INDENT) >= CODE_INDENT) {
      const code: string[] = [];
      let end = i;
      while (end < lines.length) {
        if (lines[end].trim() && columnsOf(leadingOf(lines[end]), CODE_INDENT) < CODE_INDENT) break;
        end++;
      }
      while (end > i && !lines[end - 1].trim()) end--;
      for (let k = i; k < end; k++) code.push(dedent(lines[k], CODE_INDENT, CODE_INDENT));
      blocks.push({ type: 'code', text: code.join('\n'), line: at });
      i = end;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i], fence)) {
        code.push(dedent(lines[i], fence.indent));
        i++;
      }
      i++;
      blocks.push({
        type: 'code', text: code.join('\n'), lang: fence.lang, line: at,
      });
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      flush();
      blocks.push({
        type: 'heading', level: heading.level, text: heading.text, id: heading.id || '', line: at,
      });
      i++;
      continue;
    }
    if (isRule(line)) {
      flush();
      blocks.push({ type: 'rule', line: at });
      i++;
      continue;
    }
    const embed = EMBED.exec(line);
    if (embed) {
      flush();
      blocks.push(embedOf(embed, at));
      i++;
      continue;
    }
    if (line.includes('|') && !paragraph.length && TABLE_SEPARATOR.test(lines[i + 1] || '')) {
      flush();
      const header = splitRow(line).slice(0, MAX_TABLE_COLUMNS);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      let next = i + 2;
      while (next < lines.length && lines[next].includes('|') && lines[next].trim()) {
        // Потолок ячеек: каждая ячейка — виджет в Qt-клиенте; лишние строки съедаются
        if ((rows.length + 2) * Math.max(header.length, 1) <= MAX_TABLE_CELLS) {
          const cells = splitRow(lines[next]);
          rows.push(header.map((_, n) => cells[n] || ''));
        }
        next++;
      }
      blocks.push({
        type: 'table', header, align: header.map((_, n) => align[n]), rows, line: at,
      });
      i = next;
      continue;
    }
    if (itemOf(line)) {
      flush();
      i = parseList(lines, lineNos, i, depth, blocks);
      continue;
    }
    if (quoteOf(line) !== undefined) {
      flush();
      i = parseQuote(lines, lineNos, i, depth, blocks);
      continue;
    }
    if (!paragraph.length) paragraphLine = at;
    paragraph.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}

function parseQuote(lines: string[], lineNos: number[], start: number, depth: number, out: MdBlock[]) {
  const inner: string[] = [];
  const innerNos: number[] = [];
  let i = start;
  let lazyAllowed = false;
  while (i < lines.length) {
    const quoted = quoteOf(lines[i]);
    if (quoted !== undefined) {
      inner.push(quoted);
      innerNos.push(lineNos[i]);
      // Ленивое продолжение — только у абзаца (не после пустой строки, кода, заголовка)
      lazyAllowed = Boolean(quoted.trim()) && !startsBlock(quoted) && !/^\s*>/.test(quoted);
      i++;
      continue;
    }
    if (lazyAllowed && lines[i].trim() && !startsBlock(lines[i])) {
      inner.push(lines[i]);
      innerNos.push(lineNos[i]);
      i++;
      continue;
    }
    break;
  }
  let callout: MdCallout | undefined;
  const head = /^\[!([A-Za-z]{1,20})\]([+-]?)[ \t]*(.*)$/.exec(inner[0] || '');
  if (head) {
    callout = { kind: head[1].toLowerCase(), title: head[3].trim() };
    if (head[2]) callout.fold = head[2] === '-' ? 'closed' : 'open';
    inner.shift();
    innerNos.shift();
  }
  const blocks = depth < MAX_DEPTH
    ? parseBlocks(inner, innerNos, depth + 1)
    : (inner.length ? [{ type: 'paragraph' as const, text: inner.join('\n'), line: innerNos[0] }] : []);
  out.push({
    type: 'quote', blocks, callout, line: lineNos[start],
  });
  return i;
}

function parseList(lines: string[], lineNos: number[], start: number, depth: number, out: MdBlock[]) {
  const items: MdListItem[] = [];
  // Последний номер на каждой глубине (сбрасывается пунктом мельче)
  const numbers: (number | undefined)[] = [];
  let i = start;
  let contentColumn = 0;
  let child: string[] = [];
  let childNos: number[] = [];
  // Открытый блок кода среди строк пункта: строки с отступом принадлежат ему, даже если похожи на пункт
  let childFence: Fence | undefined;
  let lazyAllowed = false;

  const pushChild = (line: string, lineNo: number) => {
    child.push(line);
    childNos.push(lineNo);
    if (childFence) {
      if (isFenceClose(line, childFence)) childFence = undefined;
    } else {
      childFence = fenceOpen(line);
    }
  };

  const closeChild = () => {
    const item = items[items.length - 1];
    while (child.length && !child[child.length - 1].trim()) {
      child.pop();
      childNos.pop();
    }
    if (item && child.length) {
      const blocks = depth < MAX_DEPTH
        ? parseBlocks(child, childNos, depth + 1)
        : [{ type: 'paragraph' as const, text: child.join('\n').trim(), line: childNos[0] }];
      if (blocks.length) item.blocks = [...(item.blocks || []), ...blocks];
    }
    child = [];
    childNos = [];
    childFence = undefined;
  };

  while (i < lines.length) {
    const line = lines[i];
    const item = itemOf(line);
    const inChildFence = Boolean(childFence);
    if (item && !(inChildFence && columnsOf(leadingOf(line)) >= contentColumn)) {
      if (i > start && !lines[i - 1].trim()) break;
      closeChild();
      const itemDepth = Math.floor(item.indent / INDENT_STEP);
      numbers.length = itemDepth + 1;
      let number: number | undefined;
      if (item.number !== undefined) {
        const previous = numbers[itemDepth];
        number = previous !== undefined ? previous + 1 : item.number;
      }
      numbers[itemDepth] = number;
      items.push({
        text: item.text,
        depth: itemDepth,
        isChecked: item.isChecked,
        number,
        line: lineNos[i],
      });
      contentColumn = item.contentColumn;
      lazyAllowed = Boolean(item.text);
      i++;
      continue;
    }
    if (!line.trim()) {
      // Пустая строка: пункт продолжается, только если дальше строка с отступом его текста
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (inChildFence || (next < lines.length && columnsOf(leadingOf(lines[next])) >= contentColumn
        && !itemOf(lines[next]))) {
        for (; i < next; i++) pushChild('', lineNos[i]);
        lazyAllowed = false;
        continue;
      }
      break;
    }
    if (columnsOf(leadingOf(line)) >= contentColumn || inChildFence) {
      pushChild(dedent(line, contentColumn), lineNos[i]);
      i++;
      continue;
    }
    // Ленивое продолжение текста пункта: строка без отступа сразу после него
    if (lazyAllowed && !child.length && !startsBlock(line)) {
      const last = items[items.length - 1];
      last.text = `${last.text}\n${line.trim()}`;
      i++;
      continue;
    }
    break;
  }
  closeChild();
  out.push({
    type: 'list', isOrdered: items[0].number !== undefined, items, line: lineNos[start],
  });
  return i;
}

function assignIds(blocks: MdBlock[], used: Map<string, number>) {
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (!block.id) {
        const base = slugOf(block.text);
        const count = used.get(base);
        block.id = count === undefined ? base : `${base}-${count}`;
        used.set(base, (count || 0) + 1);
      }
    } else if (block.type === 'quote') {
      assignIds(block.blocks, used);
    } else if (block.type === 'list') {
      block.items.forEach((item) => item.blocks && assignIds(item.blocks, used));
    }
  }
}

/** Якорь заголовка как у GitHub: нижний регистр, без знаков препинания, пробел → `-` */
export function slugOf(text: string) {
  return Array.from(inlineText(text).toLowerCase())
    .filter((c) => /[\p{L}\p{N}_ -]/u.test(c))
    .join('')
    .replace(/ /g, '-');
}

// ── строка ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Строка → куски с начертаниями. Ссылка только http(s)/mailto/`#якорь`, иначе остаётся текстом */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  parseSpan(text, 0, text.length, 0, undefined, out, 0);
  return out;
}

/** Текст строки без разметки */
export function inlineText(text: string) {
  return parseInline(text).map((part) => part.text).join('');
}

const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  bdquo: '„',
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  deg: '°',
  middot: '·',
  bull: '•',
  sect: '§',
  para: '¶',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  infin: '∞',
  check: '✓',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwj: '‍',
  zwnj: '‌',
};
const TAG_STYLES: Record<string, number> = {
  u: MD_UNDERLINE,
  ins: MD_UNDERLINE,
  mark: MD_MARK,
  sub: MD_SUB,
  sup: MD_SUP,
  kbd: MD_CODE,
  code: MD_CODE,
  b: MD_BOLD,
  strong: MD_BOLD,
  i: MD_ITALIC,
  em: MD_ITALIC,
  s: MD_STRIKE,
  del: MD_STRIKE,
  strike: MD_STRIKE,
};

function cpAt(s: string, i: number) {
  return i >= 0 && i < s.length ? s.codePointAt(i)! : undefined;
}

function cpBefore(s: string, i: number) {
  if (i <= 0) return undefined;
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.codePointAt(i - 2);
  }
  return low;
}

function isSpaceCp(cp: number | undefined) {
  return cp === undefined || /\s/.test(String.fromCodePoint(cp));
}

function isWordCp(cp: number | undefined) {
  return cp !== undefined && /[\p{L}\p{N}]/u.test(String.fromCodePoint(cp));
}

function isTagCp(cp: number | undefined) {
  return cp !== undefined && /[\p{L}\p{N}_/-]/u.test(String.fromCodePoint(cp));
}

function runLength(s: string, i: number, to: number) {
  let j = i;
  while (j < to && s[j] === s[i]) j++;
  return j - i;
}

/** Конец кода с `i` (позиция после закрывающих кавычек) и его текст либо undefined */
function codeSpanAt(s: string, i: number, to: number) {
  const n = runLength(s, i, to);
  const limit = Math.min(to, i + n + SCAN_LIMIT);
  let j = i + n;
  while (j < limit) {
    if (s[j] !== '`') {
      j++;
      continue;
    }
    const m = runLength(s, j, to);
    if (m === n) {
      let text = s.slice(i + n, j).replace(/\n/g, ' ');
      if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
      return { end: j + m, text };
    }
    j += m;
  }
  return undefined;
}

/**
 * Закрывающий знак начертания: позиция начала либо -1. Открытия того же знака внутри (`*a **b** c*`) копятся стеком
 * и закрываются раньше: закрывающая серия сперва гасит их, остаток может закрыть искомое (`**a *b***`)
 */
function findCloser(s: string, from: number, to: number, char: string, length: number) {
  const limit = Math.min(to, from + SCAN_LIMIT);
  const stack: number[] = [];
  let j = from;
  while (j < limit) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      const code = codeSpanAt(s, j, to);
      j = code ? code.end : j + runLength(s, j, to);
      continue;
    }
    if (c !== char) {
      j++;
      continue;
    }
    let m = runLength(s, j, to);
    const before = cpBefore(s, j);
    const after = cpAt(s, j + m);
    const canClose = !isSpaceCp(before) && (char !== '_' || !isWordCp(after));
    const canOpen = !isSpaceCp(after) && (char !== '_' || !isWordCp(before));
    let at = j;
    if (canClose) {
      while (m && stack.length) {
        const top = stack.pop()!;
        const used = Math.min(top, m);
        m -= used;
        at += used;
        if (top > used) stack.push(top - used);
      }
      if (m >= length && (m === length || !canOpen)) return at;
    }
    if (canOpen && m) stack.push(m);
    j += runLength(s, j, to);
  }
  return -1;
}

/** `[подпись](адрес "заголовок")`: конец, подпись и адрес либо undefined; `i` — на `[` */
function linkAt(s: string, i: number, to: number) {
  const limit = Math.min(to, i + SCAN_LIMIT);
  let level = 0;
  let j = i;
  for (; j < limit; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
    } else if (c === '[') {
      level++;
    } else if (c === ']') {
      level--;
      if (!level) break;
    } else if (c === '\n' && s[j + 1] === '\n') {
      return undefined;
    }
  }
  if (j >= limit || s[j + 1] !== '(') return undefined;
  const labelEnd = j;
  let k = j + 2;
  while (k < to && (s[k] === ' ' || s[k] === '\t')) k++;
  let url: string;
  if (s[k] === '<') {
    const close = indexOfWithin(s, '>', k + 1, limit);
    if (close < 0 || s.slice(k + 1, close).includes('\n')) return undefined;
    url = s.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    const from = k;
    for (; k < to && k < from + SCAN_LIMIT; k++) {
      const c = s[k];
      if (c === '\\' && k + 1 < to) {
        k++;
      } else if (c === '(') {
        parens++;
      } else if (c === ')') {
        if (!parens) break;
        parens--;
      } else if (/\s/.test(c)) {
        break;
      }
    }
    url = s.slice(from, k).replace(/\\(.)/g, '$1');
  }
  while (k < to && (s[k] === ' ' || s[k] === '\t')) k++;
  if (s[k] === '"' || s[k] === '\'' || s[k] === '(') {
    const close = indexOfWithin(s, s[k] === '(' ? ')' : s[k], k + 1, Math.min(to, k + SCAN_LIMIT));
    if (close < 0) return undefined;
    k = close + 1;
    while (k < to && (s[k] === ' ' || s[k] === '\t')) k++;
  }
  if (s[k] !== ')') return undefined;
  return {
    labelFrom: i + 1, labelTo: labelEnd, url, end: k + 1,
  };
}

/** Голый адрес `https://…` / `www.…` с `i`: конец либо undefined */
function bareUrlAt(s: string, i: number, to: number) {
  const head = s.slice(i, i + 8).toLowerCase();
  if (!head.startsWith('http://') && !head.startsWith('https://') && !head.startsWith('www.')) return undefined;
  const before = cpBefore(s, i);
  if (before !== undefined && !isSpaceCp(before) && !'(*_~«'.includes(String.fromCodePoint(before))) return undefined;
  let j = i;
  while (j < to && j < i + SCAN_LIMIT && !/[\s<>]/.test(s[j])) j++;
  // Хвостовые знаки препинания и непарная `)` — не часть адреса
  for (;;) {
    const c = s[j - 1];
    if ('.,:;!?\'"*_~»'.includes(c)) {
      j--;
    } else if (c === ')') {
      const body = s.slice(i, j);
      if ((body.match(/\(/g) || []).length < (body.match(/\)/g) || []).length) j--;
      else break;
    } else {
      break;
    }
  }
  const scheme = head.startsWith('www.') ? 4 : head.startsWith('https://') ? 8 : 7;
  return j - i > scheme ? j : undefined;
}

function pushRun(out: MdInline[], run: MdInline) {
  if (!run.text) return;
  if (!run.style) delete run.style;
  const last = out[out.length - 1];
  if (last && (run.type === 'text' || run.type === 'link') && last.type === run.type
    && (last.style || 0) === (run.style || 0) && last.url === run.url) {
    last.text += run.text;
    return;
  }
  out.push(run);
}

function parseSpan(s: string, from: number, to: number, style: number, link: string | undefined, out: MdInline[],
  depth: number) {
  let buffer = '';
  const flushText = () => {
    if (buffer) {
      pushRun(out, link ? {
        type: 'link', text: buffer, url: link, style,
      } : { type: 'text', text: buffer, style });
    }
    buffer = '';
  };
  const nested = (a: number, b: number, extra: number, url = link) => {
    flushText();
    if (depth >= MAX_DEPTH) {
      pushRun(out, url ? {
        type: 'link', text: s.slice(a, b), url, style: style | extra,
      } : { type: 'text', text: s.slice(a, b), style: style | extra });
    } else {
      parseSpan(s, a, b, style | extra, url, out, depth + 1);
    }
  };

  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '\\') {
      const next = s[i + 1];
      if (i + 1 < to && next === '\n') {
        buffer += '\n';
        i += 2;
        continue;
      }
      if (i + 1 < to && PUNCT.includes(next)) {
        buffer += next;
        i += 2;
        continue;
      }
      buffer += c;
      i++;
      continue;
    }
    if (c === '`') {
      const code = codeSpanAt(s, i, to);
      if (code) {
        flushText();
        pushRun(out, link ? {
          type: 'link', text: code.text, url: link, style: style | MD_CODE,
        } : { type: 'text', text: code.text, style: style | MD_CODE });
        i = code.end;
      } else {
        const n = runLength(s, i, to);
        buffer += s.slice(i, i + n);
        i += n;
      }
      continue;
    }
    if (c === '<') {
      if (s.startsWith('<!--', i)) {
        const end = indexOfWithin(s, '-->', i + 4, Math.min(to, i + 4 + SCAN_LIMIT));
        if (end >= 0) {
          i = end + 3;
          continue;
        }
      }
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]{1,2000}|[^\s<>@]{1,200}@[^\s<>@]{1,200}\.[^\s<>@]{1,50})>/i
        .exec(s.slice(i, Math.min(to, i + 2500)));
      if (auto && !link) {
        flushText();
        const url = /^(?:https?:|mailto:)/i.test(auto[1]) ? auto[1] : `mailto:${auto[1]}`;
        pushRun(out, {
          type: 'link', text: auto[1].replace(/^mailto:/i, ''), url, style,
        });
        i += auto[0].length;
        continue;
      }
      const tag = /^<([a-zA-Z]{1,6})(?:\s[^<>]{0,200})?\s*\/?>/.exec(s.slice(i, Math.min(to, i + 220)));
      const name = tag?.[1].toLowerCase();
      if (tag && name === 'br') {
        buffer += '\n';
        i += tag[0].length;
        continue;
      }
      if (tag && name && TAG_STYLES[name] !== undefined) {
        const a = i + tag[0].length;
        const close = findClosingTag(s, a, Math.min(to, a + SCAN_LIMIT), name);
        if (close >= 0) {
          nested(a, close, TAG_STYLES[name]);
          i = close + name.length + 3;
          continue;
        }
      }
      buffer += c;
      i++;
      continue;
    }
    if (c === '&') {
      const entity = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(s.slice(i, i + 40));
      if (entity) {
        const body = entity[1];
        let value: string | undefined;
        if (body.startsWith('#')) {
          const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          value = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
            ? String.fromCodePoint(code) : '�';
        } else {
          value = ENTITIES[body];
        }
        if (value !== undefined) {
          buffer += value;
          i += entity[0].length;
          continue;
        }
      }
      buffer += c;
      i++;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      if (s[i + 2] === '[') {
        const note = noteAt(s, i + 1, to);
        if (note) {
          flushText();
          pushRun(out, link ? {
            type: 'link', text: note.text, url: link, style,
          } : {
            type: 'note', text: note.text, target: note.target, style,
          });
          i = note.end;
          continue;
        }
      }
      const image = linkAt(s, i + 1, to);
      if (image) {
        // Картинка в строке — подписью (внутри ссылки — подписью ссылки), адрес http(s) — ссылкой
        const url = link || (WEB_URL.test(image.url) ? image.url : undefined);
        const alt = s.slice(image.labelFrom, image.labelTo);
        if (alt) nested(image.labelFrom, image.labelTo, 0, url);
        else if (url) {
          flushText();
          pushRun(out, {
            type: 'link', text: image.url, url, style,
          });
        }
        i = image.end;
        continue;
      }
    }
    if (c === '[') {
      if (s[i + 1] === '[') {
        const note = noteAt(s, i, to);
        if (note) {
          flushText();
          pushRun(out, link ? {
            type: 'link', text: note.text, url: link, style,
          } : {
            type: 'note', text: note.text, target: note.target, style,
          });
          i = note.end;
          continue;
        }
      }
      const found = linkAt(s, i, to);
      if (found) {
        const url = found.url.trim();
        const isSafe = SAFE_URL.test(url) || (url.startsWith('#') && url.length > 1);
        const target = link || (isSafe ? url : undefined);
        if (found.labelTo > found.labelFrom) {
          nested(found.labelFrom, found.labelTo, 0, target);
        } else if (target) {
          flushText();
          pushRun(out, {
            type: 'link', text: url, url: target, style,
          });
        }
        i = found.end;
        continue;
      }
      buffer += c;
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~' || c === '=') {
      const n = runLength(s, i, to);
      const after = cpAt(s, i + n);
      const before = cpBefore(s, i);
      const isOpener = !isSpaceCp(after) && (c !== '_' || !isWordCp(before));
      const isValid = c === '*' || c === '_' ? n <= 3 : n === 2;
      if (isOpener && isValid) {
        const close = findCloser(s, i + n, to, c, n);
        if (close > i + n) {
          let extra = c === '~' ? MD_STRIKE : c === '=' ? MD_MARK : 0;
          if (c === '*' || c === '_') extra = n === 1 ? MD_ITALIC : n === 2 ? MD_BOLD : MD_BOLD | MD_ITALIC;
          nested(i + n, close, extra);
          i = close + n;
          continue;
        }
      }
      buffer += s.slice(i, i + n);
      i += n;
      continue;
    }
    if (c === '%' && s[i + 1] === '%') {
      const end = s.indexOf('%%', i + 2);
      if (end >= 0 && end + 2 <= to) {
        i = end + 2;
        continue;
      }
    }
    if (c === '#' && isSpaceCp(cpBefore(s, i)) && !link) {
      let j = i + 1;
      while (j < to && isTagCp(cpAt(s, j))) j += cpAt(s, j)! > 0xffff ? 2 : 1;
      const body = s.slice(i + 1, j);
      if (body && !/^\d+$/.test(body)) {
        flushText();
        pushRun(out, { type: 'tag', text: s.slice(i, j), style });
        i = j;
        continue;
      }
    }
    if ((c === 'h' || c === 'H' || c === 'w' || c === 'W') && !link) {
      const end = bareUrlAt(s, i, to);
      if (end) {
        flushText();
        const text = s.slice(i, end);
        pushRun(out, {
          type: 'link', text, url: /^www\./i.test(text) ? `https://${text}` : text, style,
        });
        i = end;
        continue;
      }
    }
    buffer += c;
    i++;
  }
  flushText();
}

/** Первое вхождение `needle`, начинающееся в [from, limit), либо -1 (поиск не уходит за окно) */
function indexOfWithin(s: string, needle: string, from: number, limit: number) {
  for (let j = from; j < limit; j++) {
    if (s.startsWith(needle, j)) return j;
  }
  return -1;
}

/** `</имя>` без учёта регистра латиницы в [from, to): позиция `<` либо -1 */
function findClosingTag(s: string, from: number, to: number, name: string) {
  const needle = `</${name}>`;
  for (let j = from; j + needle.length <= to; j++) {
    if (s[j] === '<' && s.slice(j, j + needle.length).toLowerCase() === needle) return j;
  }
  return -1;
}

/** `[[цель|подпись]]` с `i` (на первой `[`): конец, подпись и цель либо undefined */
function noteAt(s: string, i: number, to: number) {
  const close = indexOfWithin(s, ']]', i + 2, Math.min(to, i + 302) + 1);
  if (close < 0) return undefined;
  const inner = s.slice(i + 2, close);
  if (!inner || /[[\]\n]/.test(inner)) return undefined;
  const [target, alias] = inner.split('|');
  if (!target.trim()) return undefined;
  return { end: close + 2, text: (alias || target).trim(), target: target.trim() };
}

// ── встроенные файлы ──────────────────────────────────────────────────────────────────────────────────────────

/** Имена встроенных файлов облака (без внешних адресов), по порядку и без повторов */
export function embedNames(markdown: string) {
  const names: string[] = [];
  const walk = (blocks: MdBlock[]) => blocks.forEach((block) => {
    if (block.type === 'embed') {
      if (!block.url && !names.includes(block.name)) names.push(block.name);
    } else if (block.type === 'quote') {
      walk(block.blocks);
    } else if (block.type === 'list') {
      block.items.forEach((item) => item.blocks && walk(item.blocks));
    }
  });
  walk(parseMarkdown(markdown));
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

/** Все строки с разметкой по порядку обхода (сверка разбора web ↔ ядро) */
export function collectTexts(blocks: MdBlock[], out: string[] = []) {
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') {
      out.push(block.text);
    } else if (block.type === 'list') {
      block.items.forEach((item) => {
        out.push(item.text);
        if (item.blocks) collectTexts(item.blocks, out);
      });
    } else if (block.type === 'quote') {
      if (block.callout?.title) out.push(block.callout.title);
      collectTexts(block.blocks, out);
    } else if (block.type === 'table') {
      out.push(...block.header);
      block.rows.forEach((row) => out.push(...row));
    }
  }
  return out;
}
