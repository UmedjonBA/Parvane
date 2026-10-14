// Статья (ARTICLE-1): разбор Markdown заметки для окна чтения. Только чтение: заголовки, абзацы, списки
// (с галочками и нумерованные), цитаты, код, черта; в строке — жирный, курсив, код, ссылки, [[заметки]],
// #теги. Картинки заметки в статью не входят — на их месте подпись.

export type ArticleInline =
  | { type: 'text'; text: string }
  | { type: 'bold' | 'italic' | 'code' | 'note' | 'tag'; text: string }
  | { type: 'link'; text: string; url: string };

export type ArticleListItem = { text: string; depth: number; isChecked?: boolean };

export type ArticleBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; isOrdered: boolean; items: ArticleListItem[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'image'; name: string };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const TASK = /^(\s*)[-*+] \[( |x|X)\](?: (.*))?$/;
const BULLET = /^(\s*)[-*+] (.*)$/;
const ORDERED = /^(\s*)\d+[.)] (.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const IMAGE = /^\s*!(?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[([^\]]*)\]\(([^)\s]+)[^)]*\))\s*$/;
const FRONT_MATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;
const INLINE = new RegExp([
  '\\*\\*[^*\\n]+\\*\\*',
  '`[^`\\n]+`',
  '\\[\\[[^\\]\\n]+\\]\\]',
  '\\[[^\\]\\n]+\\]\\([^)\\s]+\\)',
  // Курсив и тег — с начала строки либо после пробела (пробел попадает в найденное: просмотра назад нет
  // в старых Safari)
  '(?:^|\\s)[*_][^*_\\n]+[*_]',
  '(?:^|\\s)#[\\p{L}\\d_/-]+',
].map((part) => `(?:${part})`).join('|'), 'u');
const SAFE_URL = /^(?:https?:|mailto:)/i;
// Отступ вложенного пункта: два пробела либо табуляция на уровень
const INDENT_STEP = 2;

/** Блоки статьи. Первый заголовок, повторяющий название, пропускается: название стоит над текстом */
export function parseArticle(markdown: string, title = ''): ArticleBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(FRONT_MATTER, '').split('\n');
  const blocks: ArticleBlock[] = [];
  const ownTitle = title.trim().toLowerCase();
  let paragraph: string[] = [];
  let code: string[] | undefined;
  let quote: string[] = [];
  let list: Extract<ArticleBlock, { type: 'list' }> | undefined;

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    if (quote.length) blocks.push({ type: 'quote', text: quote.join('\n') });
    if (list) blocks.push(list);
    paragraph = [];
    quote = [];
    list = undefined;
  };
  const addItem = (isOrdered: boolean, item: ArticleListItem) => {
    if (paragraph.length || quote.length || (list && list.isOrdered !== isOrdered)) flush();
    list ||= { type: 'list', isOrdered, items: [] };
    list.items.push(item);
  };

  lines.forEach((line) => {
    if (code) {
      if (FENCE.test(line)) {
        blocks.push({ type: 'code', text: code.join('\n') });
        code = undefined;
      } else {
        code.push(line);
      }
      return;
    }
    if (FENCE.test(line)) {
      flush();
      code = [];
      return;
    }
    if (!line.trim()) {
      flush();
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const text = heading[2].trim();
      if (!blocks.length && text.toLowerCase() === ownTitle) return;
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3, text });
      return;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      return;
    }
    const image = IMAGE.exec(line);
    if (image) {
      flush();
      blocks.push({ type: 'image', name: (image[1] || image[2] || image[3] || '').trim() });
      return;
    }
    const task = TASK.exec(line);
    if (task) {
      addItem(false, { text: task[3] || '', depth: depthOf(task[1]), isChecked: task[2] !== ' ' });
      return;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      addItem(false, { text: bullet[2], depth: depthOf(bullet[1]) });
      return;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      addItem(true, { text: ordered[2], depth: depthOf(ordered[1]) });
      return;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      if (paragraph.length || list) flush();
      quote.push(quoted[1]);
      return;
    }
    if (quote.length || list) flush();
    paragraph.push(line);
  });
  if (code) blocks.push({ type: 'code', text: code.join('\n') });
  flush();
  return blocks;
}

/** Строка статьи → куски с разметкой. Ссылка только http(s)/mailto, иначе остаётся текстом */
export function parseArticleInline(text: string): ArticleInline[] {
  const parts: ArticleInline[] = [];
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

function inlineOf(token: string): ArticleInline {
  if (token.startsWith('**')) return { type: 'bold', text: token.slice(2, -2) };
  if (token.startsWith('`')) return { type: 'code', text: token.slice(1, -1) };
  if (token.startsWith('[[')) {
    const [target, alias] = token.slice(2, -2).split('|');
    return { type: 'note', text: (alias || target).trim() };
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

function mergeText(parts: ArticleInline[]) {
  return parts.reduce<ArticleInline[]>((out, part) => {
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
