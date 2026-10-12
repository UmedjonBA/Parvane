// Ссылки на заметки «Знаний» в названии записи «Плана»: `[[Заметка]]` и `[[Заметка|подпись]]`

// Часть названия: обычный текст либо ссылка (`note` — название заметки, `text` — что показать)
export type PlannerNamePart = { text: string; note?: string };

const NOTE_LINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;
// Знаки-заглушки: область частного использования Юникода — не буквы, не цифры и не знаки препинания
const MASK_FIRST = 0xe000;
const MASK_LAST = 0xf8ff;
const MASK_RUN = /([\ue000-\uf8ff])\1*/g;

/** Название записи по частям: текст и ссылки на заметки. Скобки без названия остаются текстом. */
export function splitNameLinks(name: string): PlannerNamePart[] {
  const result: PlannerNamePart[] = [];
  let position = 0;
  for (const match of name.matchAll(NOTE_LINK)) {
    const note = match[1].trim();
    if (!note) continue;
    if (match.index > position) result.push({ text: name.slice(position, match.index) });
    result.push({ text: match[2]?.trim() || note, note });
    position = match.index + match[0].length;
  }
  if (position < name.length) result.push({ text: name.slice(position) });
  return result;
}

/** Название без разметки ссылок — для подсказок и подписей, где ссылку не нажать. */
export function formatPlainName(name: string) {
  return splitNameLinks(name).map(({ text }) => text).join('');
}

/** Первая непустая строка описания без разметки ссылок — вторая строка записи в расписании. */
export function formatDescriptionLine(description?: string) {
  const line = (description || '').split('\n').find((part) => part.trim());
  return line ? formatPlainName(line.trim()) : '';
}

/**
 * Ссылки строки, закрытые заглушками той же длины: разбор ввода текстом не читает слова внутри ссылки
 * («[[Встреча завтра]] сб 15:00» — запись на субботу), а позиции остальных символов не сдвигаются.
 * У каждой ссылки свой знак — `unmaskNameLinks` возвращает их на место.
 */
export function maskNameLinks(text: string): { text: string; links: string[] } {
  const links: string[] = [];
  const masked = text.replace(NOTE_LINK, (link, note: string) => {
    if (!note.trim() || MASK_FIRST + links.length > MASK_LAST) return link;
    links.push(link);
    return String.fromCharCode(MASK_FIRST + links.length - 1).repeat(link.length);
  });
  return { text: masked, links };
}

export function unmaskNameLinks(text: string, links: string[]) {
  if (!links.length) return text;
  return text.replace(MASK_RUN, (run, sign: string) => links[sign.charCodeAt(0) - MASK_FIRST] ?? run);
}
