// Заметки «Знаний»: чистые функции над текстом `.md` — свойства (YAML в начале файла), ссылки `[[…]]`,
// теги, пункты `- [ ]` с метками `^t…`, индекс связей и поиск. Без сети, хранилища и интерфейса.
// Заметку для ссылок определяет название (имя файла без `.md`): без учёта регистра и крайних пробелов.

export type NoteProperties = Record<string, string | string[]>;

export type NoteTask = {
  // Номер строки в полном тексте заметки, с нуля (свойства в начале файла тоже считаются)
  line: number;
  isDone: boolean;
  // Текст пункта без галочки и без метки
  text: string;
  // Метка связи с задачей плана без `^`: `t7f3a`
  marker?: string;
};

export type ParsedNote = {
  properties: NoteProperties;
  body: string;
  links: string[];
  tags: string[];
  tasks: NoteTask[];
  preview: string;
};

export type NoteSource = {
  id: string;
  title: string;
  folder: string;
  text: string;
  updatedAt: number;
};

export type IndexedNote = NoteSource & {
  parsed: ParsedNote;
  // Заметки, на которые ведут ссылки (без самой заметки), в порядке появления
  linkedIds: string[];
  // Названия из ссылок, для которых заметки ещё нет
  unresolved: string[];
};

export type NotesIndex = {
  notes: IndexedNote[];
  byId: (noteId: string) => IndexedNote | undefined;
  byTitle: (title: string) => IndexedNote | undefined;
  backlinks: (noteId: string) => IndexedNote[];
  // Заметки, которых ещё нет: название, как в первой ссылке, и кто на него ссылается
  unresolved: { title: string; fromIds: string[] }[];
  tags: { tag: string; count: number }[];
  search: (query: string) => IndexedNote[];
};

export type TaskMarkerChange = { line: number; oldMarker: string; newMarker: string };

const PREVIEW_LENGTH = 140;
const MARKER_ID_LENGTH = 5;
const MARKER_ATTEMPTS = 50;
const FRONT_MATTER_FENCE = '---';

const TASK_RE = /^(\s*[-*+]\s+\[)([ xX])(\](?:\s+(.*))?)$/;
const MARKER_RE = /\s\^(t[a-z0-9]{4,12})\s*$/;
const LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
const LETTER_RE = /\p{L}/u;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const PROPERTY_RE = /^([^\s:#-][^:]*?)\s*:(?:\s+(.*))?$/;
const PROPERTY_ITEM_RE = /^\s*-(?:\s+(.*))?$/;
const QUOTED_START_RE = /^["'[\]{}#&*!|>%@`]/;

// Разбор по объекту заметки: объекты заметок хранилища живут, пока заметка не изменилась, — разбор одной
// заметки делается один раз на все экраны (список, граф, холст, индекс). Ключ — сам объект, текст сверяется
const parsedByNote = new WeakMap<object, { text: string; parsed: ParsedNote }>();
const searchTextByNote = new WeakMap<object, { text: string; value: string }>();

export function parseNoteCached(note: Pick<NoteSource, 'text'>): ParsedNote {
  const cached = parsedByNote.get(note);
  if (cached && cached.text === note.text) return cached.parsed;
  const parsed = parseNote(note.text);
  parsedByNote.set(note, { text: note.text, parsed });
  return parsed;
}

/** Текст заметки для поиска (без регистра, «ё» = «е», длина сохранена) — одна строчная копия на заметку,
 * общая для указателя и палитры. */
export function noteSearchText(note: Pick<NoteSource, 'text'>) {
  const cached = searchTextByNote.get(note);
  if (cached && cached.text === note.text) return cached.value;
  const value = normalizeSearch(note.text);
  searchTextByNote.set(note, { text: note.text, value });
  return value;
}

export function parseNote(text: string): ParsedNote {
  const { properties, body, bodyLine } = splitFrontMatter(text);
  const lines = body.split('\n');
  const { masked, fenced } = maskCode(lines);

  const links = new Map<string, string>();
  const tags = new Map<string, string>();
  const tasks: NoteTask[] = [];
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    findLinks(masked[index]).forEach(({ target }) => {
      const key = normalizeNoteTitle(target);
      if (key && !links.has(key)) links.set(key, target.trim());
    });
    findTags(masked[index]).forEach((tag) => {
      const key = tag.toLowerCase();
      if (!tags.has(key)) tags.set(key, tag);
    });
    const task = readTask(line);
    if (task) tasks.push({ line: bodyLine + index, ...task });
  });

  return {
    properties,
    body,
    links: [...links.values()],
    tags: [...tags.values()],
    tasks,
    preview: buildPreview(lines, fenced),
  };
}

export function serializeNote({ properties, body }: { properties: NoteProperties; body: string }) {
  const lines = Object.entries(properties).map(([key, value]) => (
    `${key}: ${Array.isArray(value) ? `[${value.map((item) => serializeScalar(item, true)).join(', ')}]`
      : serializeScalar(value)}`
  ));
  if (!lines.length) return body;
  return [FRONT_MATTER_FENCE, ...lines, FRONT_MATTER_FENCE, body].join('\n');
}

/** Название заметки как ключ сравнения: ссылки и имена файлов сверяются по нему. */
export function normalizeNoteTitle(title: string) {
  return title.trim().toLowerCase();
}

export function setTaskDone(text: string, line: number, isDone: boolean) {
  return editLine(text, line, (content) => {
    const match = TASK_RE.exec(content);
    return match ? `${match[1]}${isDone ? 'x' : ' '}${match[3]}` : content;
  });
}

/** Ставит пункту метку ` ^t<id>`, если её ещё нет. Строка без пункта — текст прежний, метки нет. */
export function ensureTaskMarker(text: string, line: number, makeId: () => string = makeRandomId) {
  const lines = text.split('\n');
  const task = line >= 0 && line < lines.length ? readTask(lines[line]) : undefined;
  if (!task) return { text, marker: undefined };
  if (task.marker) return { text, marker: task.marker };

  const marker = makeFreeMarker(collectMarkers(lines), makeId);
  return { text: editLine(text, line, (content) => `${content.trimEnd()} ^${marker}`), marker };
}

export function findTaskLine(text: string, marker: string): number | undefined {
  const wanted = marker.replace(/^\^/, '');
  const lines = text.split('\n');
  const { fenced } = maskCode(lines);
  const index = lines.findIndex((line, i) => !fenced[i] && readTask(line)?.marker === wanted);
  return index < 0 ? undefined : index;
}

export function removeTaskLine(text: string, marker: string) {
  const line = findTaskLine(text, marker);
  if (line === undefined) return text;
  const lines = text.split('\n');
  lines.splice(line, 1);
  return lines.join('\n');
}

/** Скопированный пункт несёт чужую метку: первая строка её сохраняет, копии получают новые. */
export function dedupeTaskMarkers(text: string, makeId: () => string = makeRandomId) {
  const lines = text.split('\n');
  const { fenced } = maskCode(lines);
  const used = collectMarkers(lines);
  const seen = new Set<string>();
  const changes: TaskMarkerChange[] = [];

  lines.forEach((line, index) => {
    const oldMarker = fenced[index] ? undefined : readTask(line)?.marker;
    if (!oldMarker) return;
    if (!seen.has(oldMarker)) {
      seen.add(oldMarker);
      return;
    }
    const newMarker = makeFreeMarker(used, makeId);
    const [content, eol] = splitEol(line);
    lines[index] = `${content.replace(MARKER_RE, '')} ^${newMarker}${eol}`;
    changes.push({ line: index, oldMarker, newMarker });
  });

  return { text: changes.length ? lines.join('\n') : text, changes };
}

export function buildNotesIndex(sources: NoteSource[]): NotesIndex {
  const idByTitle = new Map<string, string>();
  sources.forEach(({ id, title }) => {
    const key = normalizeNoteTitle(title);
    // Одноимённые заметки из разных папок: ссылка ведёт на первую в списке
    if (!idByTitle.has(key)) idByTitle.set(key, id);
  });

  const notes = sources.map((source): IndexedNote => {
    const parsed = parseNoteCached(source);
    const linkedIds: string[] = [];
    const unresolved: string[] = [];
    parsed.links.forEach((link) => {
      const targetId = idByTitle.get(normalizeNoteTitle(link));
      if (!targetId) unresolved.push(link);
      else if (targetId !== source.id && !linkedIds.includes(targetId)) linkedIds.push(targetId);
    });
    return { ...source, parsed, linkedIds, unresolved };
  });

  const noteById = new Map(notes.map((note) => [note.id, note]));
  const backlinksById = new Map<string, IndexedNote[]>();
  const missing = new Map<string, { title: string; fromIds: string[] }>();
  const tagCounts = new Map<string, number>();
  notes.forEach((note) => {
    note.linkedIds.forEach((targetId) => {
      backlinksById.set(targetId, [...backlinksById.get(targetId) || [], note]);
    });
    note.unresolved.forEach((title) => {
      const key = normalizeNoteTitle(title);
      const entry = missing.get(key) || { title, fromIds: [] };
      entry.fromIds.push(note.id);
      missing.set(key, entry);
    });
    note.parsed.tags.forEach((tag) => {
      const key = tag.toLowerCase();
      tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
    });
  });

  // Строчная копия текста — из общего кэша: индекс перестраивается чаще, чем меняются заметки
  const haystacks = notes.map((note) => ({
    note, title: normalizeSearch(note.title), text: noteSearchText(note),
  }));

  return {
    notes,
    byId: (noteId) => noteById.get(noteId),
    byTitle: (title) => noteById.get(idByTitle.get(normalizeNoteTitle(title))!),
    backlinks: (noteId) => backlinksById.get(noteId) || [],
    unresolved: [...missing.values()],
    tags: [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    search: (query) => {
      const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
      const inTitle: IndexedNote[] = [];
      const inText: IndexedNote[] = [];
      haystacks.forEach(({ note, title, text }) => {
        if (terms.every((term) => title.includes(term))) inTitle.push(note);
        else if (terms.every((term) => title.includes(term) || text.includes(term))) inText.push(note);
      });
      return [...inTitle.sort(compareUpdated), ...inText.sort(compareUpdated)];
    },
  };
}

/** Перенацеливает `[[Старое]]` и `[[Старое|подпись]]` на новое название; код не трогает. */
export function renameLinks(text: string, oldTitle: string, newTitle: string) {
  const oldKey = normalizeNoteTitle(oldTitle);
  const lines = text.split('\n');
  const { masked, fenced } = maskCode(lines);
  return lines.map((line, index) => {
    if (fenced[index]) return line;
    let result = '';
    let position = 0;
    findLinks(masked[index]).forEach(({ target, alias, from, to }) => {
      if (normalizeNoteTitle(target) !== oldKey) return;
      result += `${line.slice(position, from)}[[${newTitle}${alias === undefined ? '' : `|${alias}`}]]`;
      position = to;
    });
    return result + line.slice(position);
  }).join('\n');
}

export type NoteLineLink = { target: string; alias?: string; from: number; to: number };

export type NoteLines = {
  // Строки полного текста (разрез по `\n`; `\r` в конце строки остаётся)
  lines: string[];
  // Строка, где ссылки не разбираются: свойства в начале файла и блок кода
  skipped: boolean[];
  // Ссылки строки с позициями в ней; код в строке ссылкой не считается
  links: NoteLineLink[][];
};

/** Текст заметки построчно — для правки ссылок на месте: где они стоят и какие строки разбору не подлежат. */
export function scanNoteLines(text: string): NoteLines {
  const { body, bodyLine } = splitFrontMatter(text);
  const lines = text.split('\n');
  const { masked, fenced } = maskCode(body.split('\n'));
  const isSkipped = (index: number) => index < bodyLine || fenced[index - bodyLine];
  return {
    lines,
    skipped: lines.map((_, index) => isSkipped(index)),
    links: lines.map((_, index) => (isSkipped(index) ? [] : findLinks(masked[index - bodyLine]))),
  };
}

/** Название ежедневной заметки — сам ключ дня `YYYY-MM-DD`. */
export function dailyNoteTitle(day: string) {
  return day;
}

export function dailyNoteTemplate(day: string) {
  return `# ${day}\n\n- [ ] \n`;
}

function splitFrontMatter(text: string) {
  const none = { properties: {} as NoteProperties, body: text, bodyLine: 0 };
  const lines = text.split('\n');
  if (lines[0].trimEnd() !== FRONT_MATTER_FENCE) return none;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FRONT_MATTER_FENCE);
  if (end < 0) return none;
  // Блок, который не разобрался целиком, остаётся текстом заметки: ничего не теряем
  const properties = parseProperties(lines.slice(1, end));
  if (!properties) return none;
  return { properties, body: lines.slice(end + 1).join('\n'), bodyLine: end + 1 };
}

function parseProperties(lines: string[]) {
  const properties: NoteProperties = {};
  let listKey: string | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    const item = PROPERTY_ITEM_RE.exec(line);
    if (item) {
      if (listKey === undefined) return undefined;
      const list = properties[listKey];
      properties[listKey] = [...(Array.isArray(list) ? list : []), parseScalar(item[1] || '')];
      continue;
    }

    const pair = PROPERTY_RE.exec(line);
    if (!pair) return undefined;
    const value = (pair[2] || '').trim();
    listKey = value ? undefined : pair[1];
    const isList = value.startsWith('[') && value.endsWith(']') && !(value.startsWith('[[') && value.endsWith(']]'));
    properties[pair[1]] = isList ? splitInlineList(value.slice(1, -1)).map(parseScalar) : parseScalar(value);
  }
  return properties;
}

function parseScalar(raw: string) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch (err) {
      // Не JSON-строка: кавычки снимаются как есть
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith('\'') && value.endsWith('\'')) {
    return value.slice(1, -1).replace(/''/g, '\'');
  }
  return value;
}

function splitInlineList(inner: string) {
  const items: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"' && i + 1 < inner.length) {
        i++;
        current += inner[i];
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === ',') {
      items.push(current);
      current = '';
    } else {
      if ((char === '"' || char === '\'') && !current.trim()) quote = char;
      current += char;
    }
  }
  if (current.trim() || items.length) items.push(current);
  return items;
}

function serializeScalar(value: string, isListItem?: boolean) {
  const needsQuotes = !value || value !== value.trim() || QUOTED_START_RE.test(value) || /[\n\r]/.test(value)
    || value === '-' || value.startsWith('- ') || (isListItem && /[,\]]/.test(value));
  return needsQuotes ? JSON.stringify(value) : value;
}

// Код для разбора «гасится»: строки внутри ``` помечаются, содержимое `…` заменяется пробелами той же длины
function maskCode(lines: string[]) {
  const masked: string[] = [];
  const fenced: boolean[] = [];
  let fence: string | undefined;
  lines.forEach((line) => {
    const match = FENCE_RE.exec(line);
    if (fence) {
      const isClosing = match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim();
      if (isClosing) fence = undefined;
    } else if (match) {
      fence = match[1];
    } else {
      masked.push(line.replace(INLINE_CODE_RE, (code) => ' '.repeat(code.length)));
      fenced.push(false);
      return;
    }
    masked.push('');
    fenced.push(true);
  });
  return { masked, fenced };
}

function findLinks(maskedLine: string) {
  return [...maskedLine.matchAll(LINK_RE)]
    .filter((match) => match[1].trim())
    .map((match) => ({
      target: match[1], alias: match[2], from: match.index, to: match.index + match[0].length,
    }));
}

function findTags(maskedLine: string) {
  const withoutLinks = maskedLine.replace(LINK_RE, (link) => ' '.repeat(link.length));
  return [...withoutLinks.matchAll(TAG_RE)]
    .map((match) => match[2].replace(/[-/]+$/, ''))
    .filter((tag) => LETTER_RE.test(tag));
}

function readTask(line: string) {
  const match = TASK_RE.exec(splitEol(line)[0]);
  if (!match) return undefined;
  const rest = match[4] || '';
  const marker = MARKER_RE.exec(` ${rest}`)?.[1];
  const text = (marker ? ` ${rest}`.replace(MARKER_RE, '') : rest).trim();
  return { isDone: match[2] !== ' ', text, marker };
}

function collectMarkers(lines: string[]) {
  const markers = new Set<string>();
  lines.forEach((line) => {
    const marker = readTask(line)?.marker;
    if (marker) markers.add(marker);
  });
  return markers;
}

function makeFreeMarker(used: Set<string>, makeId: () => string) {
  for (let attempt = 0; attempt < MARKER_ATTEMPTS; attempt++) {
    const marker = `t${makeId()}`;
    if (!used.has(marker)) {
      used.add(marker);
      return marker;
    }
  }
  // Генератор повторяется: добавляем счётчик, чтобы метка всё же была своей
  let suffix = used.size;
  while (used.has(`t${makeId()}${suffix.toString(36)}`)) suffix++;
  const marker = `t${makeId()}${suffix.toString(36)}`;
  used.add(marker);
  return marker;
}

function makeRandomId() {
  return Math.random().toString(36).slice(2, 2 + MARKER_ID_LENGTH).padEnd(MARKER_ID_LENGTH, '0');
}

function buildPreview(lines: string[], fenced: boolean[]) {
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const plain = stripMarkdown(lines[i]);
    if (!plain) continue;
    return plain.length > PREVIEW_LENGTH ? `${plain.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : plain;
  }
  return '';
}

function stripMarkdown(line: string) {
  const content = splitEol(line)[0];
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(content)) return '';
  return content
    .replace(/^\s*(?:>\s*)*/, '')
    .replace(/^#{1,6}(?:\s+|$)/, '')
    .replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(MARKER_RE, '')
    .replace(LINK_RE, (link, target: string, alias?: string) => (alias || target).trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/(^|[^\p{L}\p{N}])[*_]([^*_]+)[*_](?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function editLine(text: string, line: number, edit: (content: string) => string) {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) return text;
  const [content, eol] = splitEol(lines[line]);
  lines[line] = edit(content) + eol;
  return lines.join('\n');
}

function splitEol(line: string): [content: string, eol: string] {
  return line.endsWith('\r') ? [line.slice(0, -1), '\r'] : [line, ''];
}

// Без регистра и с «ё» = «е», длина сохраняется (редкие буквы вроде «İ» меняют длину при смене регистра
// и остаются как есть) — участки совпадения годятся для исходной строки
function normalizeSearch(value: string) {
  // Обычно смена регистра длину не меняет — хватает встроенного преобразования
  const whole = value.toLowerCase();
  if (whole.length === value.length) return whole.replace(/ё/g, 'е');
  let result = '';
  for (const char of value) {
    const lower = char.toLowerCase();
    const safe = lower.length === char.length ? lower : char;
    result += safe === 'ё' ? 'е' : safe;
  }
  return result;
}

function compareUpdated(a: NoteSource, b: NoteSource) {
  return b.updatedAt - a.updatedAt;
}
