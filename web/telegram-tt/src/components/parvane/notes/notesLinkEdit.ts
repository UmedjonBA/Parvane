// Заметки «Знаний»: связь, проведённая на графе, — это ссылка `[[Название]]` в тексте заметки. Чистые функции:
// дописать ссылку туда, где заметка уже держит ссылки, и убрать ссылку, не переписывая прозу.

import { normalizeNoteTitle, scanNoteLines } from './notesModel';

export type AddLinkResult = { status: 'added' | 'exists' | 'refused'; text: string };

export type RemoveLinkResult = { status: 'removed' | 'none'; text: string } | {
  // Ссылка стоит внутри предложения: текст не тронут, `from`…`to` — её место в тексте заметки
  status: 'inline';
  text: string;
  from: number;
  to: number;
};

// Знаки, которых не бывает в названии внутри `[[…]]`: скобки закрывают ссылку, черта отделяет подпись
const UNLINKABLE = /[[\]|\r\n]/;
// Строка из одних ссылок (с маркером списка или без), между ссылками — пробелы и знаки-разделители
const LINKS_ONLY = /^\s*(?:[-*+]\s+)?(?:\[\[[^[\]]+\]\][\s,;·]*)+$/;
const BULLET = /^(\s*[-*+]\s+)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
// Заголовок либо строка-подпись раздела со ссылками: «Связи», «См. также», «Links», «See also»…
const LINKS_HEADING = new RegExp(
  '^\\s*(?:#{1,6}\\s+)?(?:\\*\\*)?'
  + '(?:связи|ссылки|связанное|см\\.?\\s*также|смотри(?:те)?\\s+также|links|see\\s+also|related)'
  + '(?:\\*\\*)?\\s*:?\\s*(?:\\*\\*)?\\s*$',
  'i',
);
const SEPARATORS_BEFORE = /^[\s,;·]*/;
const SEPARATORS_AFTER = /[\s,;·]+$/;
const CRLF = '\r\n';

/** Можно ли сослаться на заметку с таким названием: в `[[…]]` не записать `[`, `]`, `|` и перенос строки. */
export function canLinkTitle(title: string) {
  return Boolean(title.trim()) && !UNLINKABLE.test(title);
}

function splitText(text: string) {
  return { eol: text.includes(CRLF) ? CRLF : '\n', lines: text.split(/\r?\n/) };
}

function lastFilled(lines: string[], from: number, to: number) {
  for (let i = to - 1; i >= from; i--) {
    if (lines[i].trim()) return i;
  }
  return -1;
}

/**
 * Дописывает ссылку `[[title]]`. Место: раздел со ссылками (заголовок «Связи», «См. также», «Links», «See also»…),
 * иначе — блок строк из одних ссылок в конце заметки, иначе — новая строка в конце после пустой. Ссылка, которая
 * уже есть (где угодно в тексте), второй раз не пишется; название, которое в ссылку не записать, — отказ.
 */
export function addLinkToText(text: string, title: string): AddLinkResult {
  const target = title.trim();
  if (!canLinkTitle(target)) return { status: 'refused', text };
  const scan = scanNoteLines(text);
  const key = normalizeNoteTitle(target);
  if (scan.links.some((found) => found.some((link) => normalizeNoteTitle(link.target) === key))) {
    return { status: 'exists', text };
  }

  const { eol, lines } = splitText(text);
  const link = `[[${target}]]`;
  // Новая строка повторяет вид соседней: в списке ссылок — пункт списка
  const like = (index: number) => `${BULLET.exec(lines[index])?.[1] || ''}${link}`;
  const isLinksLine = (index: number) => !scan.skipped[index] && LINKS_ONLY.test(lines[index]);

  let heading = -1;
  lines.forEach((line, index) => {
    if (!scan.skipped[index] && LINKS_HEADING.test(line)) heading = index;
  });
  if (heading >= 0) {
    let end = lines.findIndex((line, index) => index > heading && !scan.skipped[index] && HEADING.test(line));
    if (end < 0) end = lines.length;
    const filled = lastFilled(lines, heading + 1, end);
    const added = filled < 0 ? ['', link] : [isLinksLine(filled) ? like(filled) : link];
    const at = (filled < 0 ? heading : filled) + 1;
    // Раздел не в конце заметки: следующая за ним строка остаётся отделена пустой
    if (at < lines.length && lines[at].trim()) added.push('');
    lines.splice(at, 0, ...added);
    return { status: 'added', text: lines.join(eol) };
  }

  const last = lastFilled(lines, 0, lines.length);
  if (last < 0) return { status: 'added', text: `${link}${eol}` };
  // Заметка, кончавшаяся переводом строки, им и кончается; без него — кончается ссылкой
  const hasFinalEol = !lines[lines.length - 1].trim();
  const kept = lines.slice(0, last + 1);
  if (isLinksLine(last)) kept.push(like(last));
  else kept.push('', link);
  if (hasFinalEol) kept.push('');
  return { status: 'added', text: kept.join(eol) };
}

/**
 * Убирает ссылку на `title`. Ссылка, стоящая отдельной строкой (или в строке из одних ссылок), убирается вместе с
 * опустевшей строкой. Если хоть одна такая ссылка стоит внутри предложения, текст не меняется вовсе: связь всё
 * равно осталась бы, а прозу переписывать нельзя — возвращается место ссылки, чтобы показать его в правке.
 */
export function removeLinkFromText(text: string, title: string): RemoveLinkResult {
  const key = normalizeNoteTitle(title);
  const scan = scanNoteLines(text);
  const found: { line: number; from: number; to: number }[] = [];
  scan.links.forEach((links, line) => {
    links.forEach((link) => {
      if (normalizeNoteTitle(link.target) === key) found.push({ line, from: link.from, to: link.to });
    });
  });
  if (!found.length) return { status: 'none', text };

  const { eol, lines } = splitText(text);
  const inline = found.find(({ line }) => !LINKS_ONLY.test(lines[line]));
  if (inline) {
    const offset = scan.lines.slice(0, inline.line).reduce((sum, line) => sum + line.length + 1, 0);
    return {
      status: 'inline', text, from: offset + inline.from, to: offset + inline.to,
    };
  }

  const isBlank = (index: number) => index < 0 || index >= lines.length || !lines[index].trim();
  // С конца: удаление не сдвигает ещё не обработанные ссылки
  [...found].reverse().forEach(({ line, from, to }) => {
    const content = lines[line];
    const rest = `${content.slice(0, from)}${content.slice(to).replace(SEPARATORS_BEFORE, '')}`;
    if (rest.includes('[[')) {
      lines[line] = rest.replace(SEPARATORS_AFTER, '');
      return;
    }
    lines.splice(line, 1);
    // Пустая строка, отделявшая ссылку, уходит вместе с ней: двух пустых подряд и пустой в конце не остаётся
    if (line > 0 && isBlank(line - 1) && isBlank(line)) lines.splice(line - 1, 1);
  });
  return { status: 'removed', text: lines.join(eol) };
}
