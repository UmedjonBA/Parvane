// Ссылки на заметки «Знаний» в названии записи «Плана»: `[[Заметка]]` и `[[Заметка|подпись]]`

// Часть названия: обычный текст либо ссылка (`note` — название заметки, `text` — что показать)
export type PlannerNamePart = { text: string; note?: string };

const NOTE_LINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;

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
