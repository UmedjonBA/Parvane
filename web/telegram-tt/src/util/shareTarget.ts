import type { ParvaneModuleId } from './parvaneModules';

// «Поделиться в Parvane» (Web Share Target, `share_target` манифеста). Service worker принимает POST
// `share/` и кладёт полученное в Cache Storage (`SHARE_CACHE`): сведения — JSON по `SHARE_META_URL`, файлы —
// по `SHARE_FILE_URL<номер>`; затем открывает `?open=share`. Страница забирает полученное (`sharedInbox.ts`)
// и показывает экран «Поделиться» (`ShareSheet.tsx`). Через кэш, а не сообщением: service worker может быть
// остановлен, пока приложение загружается, а файлы сообщение не переживут
export const SHARE_CACHE = 'parvane-share';
export const SHARE_META_URL = '/__parvane-share__/meta';
export const SHARE_FILE_URL = '/__parvane-share__/file/';

export type SharedFileMeta = { name: string; type: string; size: number };
export type SharedMeta = { title?: string; text?: string; url?: string; files: SharedFileMeta[]; at: number };
export type SharedPayload = { title?: string; text?: string; url?: string; files: File[] };

export type ShareDestination = 'chat' | 'files' | 'note';

// Полученное старше этого не показывается: экран «Поделиться» после случайной перезагрузки через день не нужен
const SHARE_MAX_AGE_MS = 10 * 60 * 1000;
const NOTE_TITLE_MAX_LENGTH = 60;
const MAX_FIELD_LENGTH = 100000;

/** Поля формы `share_target`: пустые строки — как отсутствующие. */
export function readShareForm(form: FormData): { title?: string; text?: string; url?: string; files: File[] } {
  const readField = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' && value.trim() ? value.slice(0, MAX_FIELD_LENGTH) : undefined;
  };
  const files = form.getAll('files').filter((item): item is File => typeof item !== 'string' && item.size > 0);
  return {
    title: readField('title'), text: readField('text'), url: readField('url'), files,
  };
}

/** Сведения о полученном для кэша (файлы — отдельными записями). */
export function buildSharedMeta(shared: SharedPayload, now: number): SharedMeta {
  return {
    title: shared.title,
    text: shared.text,
    url: shared.url,
    files: shared.files.map((file) => ({ name: file.name || 'file', type: file.type, size: file.size })),
    at: now,
  };
}

/** Прочитать сведения из кэша: чужой либо устаревший JSON — ничего не получено. */
export function parseSharedMeta(raw: unknown, now: number): SharedMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const meta = raw as Partial<SharedMeta>;
  if (typeof meta.at !== 'number' || now - meta.at > SHARE_MAX_AGE_MS || !Array.isArray(meta.files)) return undefined;
  const readString = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const files = meta.files.filter((file): file is SharedFileMeta => Boolean(file) && typeof file.name === 'string'
    && typeof file.type === 'string' && typeof file.size === 'number');
  const result: SharedMeta = {
    title: readString(meta.title), text: readString(meta.text), url: readString(meta.url), files, at: meta.at,
  };
  return hasSharedContent(result) ? result : undefined;
}

export function hasSharedContent(shared: { title?: string; text?: string; url?: string; files: unknown[] }) {
  return Boolean(shared.title || shared.text || shared.url || shared.files.length);
}

/**
 * Текст сообщения из полученного: ссылка, заголовок и текст строками. Приложения часто кладут ссылку и в текст —
 * повтор убирается; заголовок, совпадающий с текстом, тоже.
 */
export function buildSharedText(shared: { title?: string; text?: string; url?: string }) {
  const text = shared.text?.trim();
  const url = shared.url?.trim();
  const title = shared.title?.trim();
  const lines = [
    url && !text?.includes(url) ? url : undefined,
    title && title !== text && !text?.startsWith(title) ? title : undefined,
    text,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Куда можно отправить полученное: чат — всегда; «Файлы» — только файлы; заметку — если модуль включён. */
export function getShareDestinations(
  hasFiles: boolean, isModuleOn: (id: ParvaneModuleId) => boolean,
): ShareDestination[] {
  const destinations: ShareDestination[] = ['chat'];
  if (hasFiles && isModuleOn('files')) destinations.push('files');
  if (isModuleOn('notes')) destinations.push('note');
  return destinations;
}

/** Название новой заметки: заголовок, первая строка текста либо имя первого файла. */
export function buildShareNoteTitle(shared: { title?: string; text?: string; url?: string; fileNames: string[] }) {
  const source = shared.title || shared.text || shared.url || shared.fileNames[0] || '';
  const firstLine = source.trim().split('\n')[0];
  return firstLine.replace(/[\\/:*?"<>|#[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_TITLE_MAX_LENGTH).trim();
}

/** Текст новой заметки: заголовок, полученный текст и файлы вложениями `![[имя]]`. */
export function buildShareNoteText(title: string, text: string, embeds: string[]) {
  const parts = [`# ${title}`];
  if (text) parts.push(text);
  if (embeds.length) parts.push(embeds.map((name) => `![[${name}]]`).join('\n'));
  return `${parts.join('\n\n')}\n`;
}
