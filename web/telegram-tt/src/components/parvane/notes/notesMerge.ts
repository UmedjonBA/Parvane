import { engineStatic } from '../../../api/parvane/v2/engine';

// Одна заметка с двух устройств (spec 040 T9, правило NOTES-2): построчное трёхстороннее слияние с общей версией
// считает движок (`notesMerge`, `notesMergeResolve`). Правки разных мест складываются, одинаковые берутся один
// раз; одно место, изменённое по-разному, — расхождение: его решает человек на экране расхождения
// (`NoteConflictView`). Движок должен быть загружен (`loadProtocol`).

// Участок сведённого текста: строки, сведённые сами, либо расхождение (`line` — номер строки в моей версии, с 1)
export type NotesMergePart = { text: string[] } | { base: string[]; mine: string[]; theirs: string[]; line: number };
export type NotesMergeChoice = 'mine' | 'theirs' | 'both';

type EngineMerge = { text: string; conflict: boolean; parts: NotesMergePart[]; autoLines: number };

export type NotesMergeResult = {
  // При расхождении — моя версия целиком, до решения человека
  text: string;
  hasConflict: boolean;
  parts: NotesMergePart[];
  // Сколько строк правок сведено само
  autoLines: number;
};

export function mergeNotes(base: string, mine: string, theirs: string): NotesMergeResult {
  const result = engineStatic<EngineMerge>('notesMerge', { base, mine, theirs });
  return {
    text: result.text, hasConflict: result.conflict, parts: result.parts, autoLines: result.autoLines,
  };
}

/** Текст с решёнными расхождениями: выбор по порядку расхождений, не заданный — своя строка. */
export function resolveNotes(base: string, mine: string, theirs: string, choices: NotesMergeChoice[]) {
  return engineStatic<{ text: string }>('notesMergeResolve', {
    base, mine, theirs, choices,
  }).text;
}

export function isConflictPart(part: NotesMergePart): part is Extract<NotesMergePart, { line: number }> {
  return 'line' in part;
}
