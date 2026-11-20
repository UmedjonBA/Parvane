// Время чтения статьи в чате (доска `ZpChat`: «Статья · 3 минуты чтения»): слова текста без разметки при
// обычной скорости чтения, не меньше минуты

const WORDS_PER_MINUTE = 200;

export function getReadingMinutes(markdown: string) {
  const words = markdown.replace(/[#*_`>[\]()!|~-]+/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}
