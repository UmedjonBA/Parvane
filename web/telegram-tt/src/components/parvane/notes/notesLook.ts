// Вид заметки в списках: цвет по папке, буква плитки, показ названия заметки дня, строка под названием

import type { LangFn } from '../../../util/localization';
import type { NoteEntry } from './notesStore';

import { fromDayKey } from '../planner/plannerModel';
import { GUIDE_EN } from './guide/en';
import { GUIDE_RU } from './guide/ru';
import { parseNoteCached } from './notesModel';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_MAX = 140;
// Папка справки на любом языке справки: своим цветом (доска `PhNotesMore`)
const GUIDE_FOLDERS = new Set([GUIDE_RU.folderName, GUIDE_EN.folderName]);

// Форматы дат — по одному на язык: `toLocaleDateString` создаёт формат на каждый вызов (дорого на тысячу строк)
const dayTitleFormats = new Map<string, Intl.DateTimeFormat>();
const dayShortFormats = new Map<string, Intl.DateTimeFormat>();
// Строка под названием — по объекту заметки (объекты хранилища живут, пока заметка не изменилась)
const previewByNote = new WeakMap<object, { text: string; title: string; preview: string }>();
// Цвета, выбранные человеком (`notesMeta.ts`): верхняя папка → тон
let chosenTones: ReadonlyMap<string, string> = new Map();

export function setChosenFolderTones(tones: ReadonlyMap<string, string>) {
  chosenTones = tones;
}

function formatOf(cache: Map<string, Intl.DateTimeFormat>, locale: string, options: Intl.DateTimeFormatOptions) {
  let format = cache.get(locale);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, options);
    } catch (err) {
      format = new Intl.DateTimeFormat(undefined, options);
    }
    cache.set(locale, format);
  }
  return format;
}

/** Цвет папки по доске `PhNotesMore`: заметки дня — акцент, «Без папки» — серый, справка — бирюзовый, свои
 * папки — синий, если человек не выбрал другой (цвет верхней папки — на всех экранах и у вложенных). */
export function folderColor(folder: string, isDaily?: boolean) {
  const top = folder.split('/')[0];
  if (isDaily) return 'var(--pv-accent)';
  if (!top) return 'var(--pv-muted)';
  const chosen = chosenTones.get(top);
  if (chosen) return `var(--pv-${chosen})`;
  return GUIDE_FOLDERS.has(top) ? 'var(--pv-aqua)' : 'var(--pv-blue)';
}

export function isDayTitle(title: string) {
  return DAY_KEY.test(title);
}

/** Название для показа: у заметки дня — «пн, 12 октября». */
export function displayTitle(lang: LangFn, note: Pick<NoteEntry, 'title' | 'isDaily'>) {
  if (!note.isDaily || !isDayTitle(note.title)) return note.title;
  return formatOf(dayTitleFormats, lang.code, { weekday: 'short', day: 'numeric', month: 'long' })
    .format(fromDayKey(note.title));
}

/** Знак на плитке списка: первая буква названия, у заметки дня — число. */
export function avatarText(note: Pick<NoteEntry, 'title' | 'isDaily'>) {
  if (note.isDaily && isDayTitle(note.title)) return String(fromDayKey(note.title).getDate());
  return (Array.from(note.title.trim())[0] || '').toUpperCase();
}

/** Короткая дата: «12 окт». */
export function formatDayShort(lang: LangFn, day: string) {
  return formatOf(dayShortFormats, lang.code, { day: 'numeric', month: 'short' }).format(fromDayKey(day))
    .replace(/\.$/, '');
}

// Строка начала текста заметки: `mark` — чем была строка в разметке (пункт с галочкой, пункт списка, заголовок)
export type NotePreviewLine = { text: string; mark?: 'todo' | 'done' | 'bullet' | 'heading' };

const FENCE = '```';
const PREVIEW_TASK = /^\s*[-*+] \[( |x|X)\](?: (.*))?$/;
const PREVIEW_ITEM = /^\s*[-*+] (.*)$/;
const PREVIEW_HEADING = /^#+\s+(.*)$/;

// Разметка внутри строки — упрощённо, как в строке списка заметок: ссылка показывается подписью либо
// названием заметки, метка пункта, обратные кавычки и звёздочки жирного убираются
function plainInline(text: string) {
  return text
    .replace(/ \^t[a-z0-9]{4,12}\s*$/, '')
    .replace(/\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g, (link, title: string, alias?: string) => alias?.trim() || title)
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`/g, '')
    .trim();
}

/**
 * Начало текста заметки для карточки (заметка дня на «Сегодня»): первые `max` содержательных строк без
 * блока свойств, заголовка с названием, блоков кода и пустых пунктов шаблона. `hasMore` — текст длиннее.
 */
export function previewLines(note: Pick<NoteEntry, 'title' | 'text'>, max: number) {
  const title = note.title.trim().toLowerCase();
  const lines: NotePreviewLine[] = [];
  let isCode = false;
  parseNoteCached(note).body.split('\n').forEach((raw) => {
    if (raw.trim().startsWith(FENCE)) {
      isCode = !isCode;
      return;
    }
    if (isCode) return;
    const task = PREVIEW_TASK.exec(raw);
    const item = !task && PREVIEW_ITEM.exec(raw);
    const heading = !task && !item && PREVIEW_HEADING.exec(raw);
    const text = plainInline(task ? task[2] || '' : item ? item[1] : heading ? heading[1] : raw).slice(0, PREVIEW_MAX);
    if (!text || (heading && text.toLowerCase() === title)) return;
    const mark = task ? (task[1] === ' ' ? 'todo' : 'done') : item ? 'bullet' : heading ? 'heading' : undefined;
    lines.push(mark ? { text, mark } : { text });
  });
  return { lines: lines.slice(0, max), hasMore: lines.length > max };
}

// Строка под названием в списке: первая содержательная строка текста, не повторяющая само название
export function previewOf(note: Pick<NoteEntry, 'title' | 'text'>) {
  const cached = previewByNote.get(note);
  if (cached && cached.text === note.text && cached.title === note.title) return cached.preview;
  const title = note.title.trim().toLowerCase();
  let line: string | undefined;
  // Строки просматриваются по одной до первой содержательной: весь текст не преобразуется
  for (const raw of parseNoteCached(note).body.split('\n')) {
    const item = raw.replace(/^#+\s*|^\s*[-*+] (\[[ xX]\] )?/, '')
      .replace(/ \^t[a-z0-9]{4,12}\s*$/, '')
      .replace(/\[\[([^[\]|]+)(\|[^[\]]+)?\]\]/g, '$1')
      .replace(/`/g, '')
      .trim();
    if (item && item.toLowerCase() !== title) {
      line = item;
      break;
    }
  }
  const preview = (line || '').slice(0, PREVIEW_MAX);
  previewByNote.set(note, { text: note.text, title: note.title, preview });
  return preview;
}
