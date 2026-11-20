import type { GuideNote } from '../../../parvane/notes/notesGuide';

export type HelpMatch = {
  note: GuideNote;
  // Строка текста заметки с найденным (без разметки); совпало только название — нет
  snippet?: string;
};

const SNIPPET_MAX_LENGTH = 120;
// Разметка в начале строки: заголовки, пункты, цитаты, задачи
const LINE_MARKUP = /^\s*(?:#+|[-*>]|\d+\.|\[[ x]\])\s*/i;

// Поиск по «Справке Parvane» (доска `RpProfileA`): все слова запроса — в названии либо в тексте заметки справки,
// без учёта регистра и «ё»; заметки идут в прежнем порядке
export function searchHelp(notes: GuideNote[], query: string): HelpMatch[] {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return notes.map((note) => ({ note }));
  return notes.flatMap((note) => {
    const haystack = normalizeText(`${note.title}\n${note.text}`);
    if (!words.every((word) => haystack.includes(word))) return [];
    const isTitleMatch = words.every((word) => normalizeText(note.title).includes(word));
    return [{ note, snippet: isTitleMatch ? undefined : findSnippet(note.text, words) }];
  });
}

function findSnippet(text: string, words: string[]) {
  const lines = text.split('\n').map((line) => line.replace(LINE_MARKUP, '').trim()).filter(Boolean);
  const line = lines.find((item) => words.some((word) => normalizeText(item).includes(word)));
  if (!line) return undefined;
  return line.length > SNIPPET_MAX_LENGTH ? `${line.slice(0, SNIPPET_MAX_LENGTH - 1)}…` : line;
}

function normalizeText(text: string) {
  return text.toLocaleLowerCase().replace(/ё/g, 'е');
}
