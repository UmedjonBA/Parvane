// Правка заметки: кнопки разметки под редактором (доска `PhNotesMore`) и подсказка заметки для незакрытой
// ссылки `[[…`. Чистые функции над текстом и выделением — редактор только применяет результат.

export type EditorTool = 'heading' | 'bold' | 'task' | 'link' | 'code' | 'callout' | 'list';
export type EditorState = { text: string; from: number; to: number };

export const EDITOR_TOOLS: EditorTool[] = ['heading', 'bold', 'task', 'link', 'code', 'callout', 'list'];
// Знак на кнопке — сама разметка
export const EDITOR_TOOL_SIGNS: Record<EditorTool, string> = {
  heading: '#',
  bold: 'B',
  task: '[ ]',
  link: '[[ ]]',
  code: '</>',
  callout: '>',
  list: '—',
};

const LINE_PREFIXES = {
  heading: '# ',
  task: '- [ ] ',
  callout: '> ',
  list: '- ',
} as const;
const WRAPS = {
  bold: ['**', '**'],
  link: ['[[', ']]'],
} as const;
const FENCE = '```';
// Незакрытая ссылка перед курсором: от `[[` до курсора нет ни закрытия, ни перевода строки, ни подписи
const OPEN_LINK = /\[\[([^[\]|\n]*)$/;

/** Применить кнопку разметки: строчные встают в начало строк выделения, парные оборачивают выделение. */
export function applyEditorTool(state: EditorState, tool: EditorTool): EditorState {
  if (tool === 'code') return applyCode(state);
  if (tool === 'bold' || tool === 'link') return wrapSelection(state, WRAPS[tool][0], WRAPS[tool][1]);
  return prefixLines(state, LINE_PREFIXES[tool]);
}

/** Начало названия в незакрытой ссылке `[[…` перед курсором; ссылки нет — `undefined`. */
export function findOpenLink(text: string, caret: number) {
  const match = OPEN_LINK.exec(text.slice(0, caret));
  return match ? { query: match[1], from: caret - match[1].length } : undefined;
}

/** Дописать название в незакрытую ссылку: набранное начало заменяется названием, ссылка закрывается. */
export function completeOpenLink(state: EditorState, title: string): EditorState {
  const open = findOpenLink(state.text, state.from);
  if (!open) return state;
  const tail = state.text.slice(state.from);
  const closing = tail.startsWith(']]') ? '' : ']]';
  const text = `${state.text.slice(0, open.from)}${title}${closing}${tail}`;
  const caret = open.from + title.length + 2;
  return { text, from: caret, to: caret };
}

function wrapSelection({ text, from, to }: EditorState, before: string, after: string): EditorState {
  const selected = text.slice(from, to);
  return {
    text: `${text.slice(0, from)}${before}${selected}${after}${text.slice(to)}`,
    from: from + before.length,
    to: to + before.length,
  };
}

function prefixLines({ text, from, to }: EditorState, prefix: string): EditorState {
  const start = text.lastIndexOf('\n', from - 1) + 1;
  const lines = text.slice(start, to).split('\n');
  const block = lines.map((line) => `${prefix}${line}`).join('\n');
  return {
    text: `${text.slice(0, start)}${block}${text.slice(to)}`,
    from: from + prefix.length,
    to: to + prefix.length * lines.length,
  };
}

// Код: внутри строки — обратные кавычки, выделение из нескольких строк либо пустая строка — блок
function applyCode(state: EditorState): EditorState {
  const { text, from, to } = state;
  const selected = text.slice(from, to);
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = text.indexOf('\n', to);
  const isLineEmpty = !text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
  if (!selected.includes('\n') && !isLineEmpty) return wrapSelection(state, '`', '`');
  const lead = from > lineStart ? '\n' : '';
  const before = `${lead}${FENCE}\n`;
  return {
    text: `${text.slice(0, from)}${before}${selected}\n${FENCE}${text.slice(to)}`,
    from: from + before.length,
    to: to + before.length,
  };
}
