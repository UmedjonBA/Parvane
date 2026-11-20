import { engineStatic } from '../../../api/parvane/v2/engine';
import { parseCanvas, serializeCanvas } from './notesCanvas';

// Холст, правленный на двух устройствах (spec 040 T9, правило NOTES-3): трёхстороннее слияние по id карточек и
// стрелок с общей версией считает движок (`notesCanvasMerge`). Правки разных карточек и разных полей складываются;
// одно поле, изменённое по-разному, остаётся своим. Движок должен быть загружен (`loadProtocol`).

type EngineMerge = { doc: unknown; conflicts: number };

export type CanvasMergeResult = { text: string; conflicts: number };

/** Сведённый текст файла холста (в порядке ключей `serializeCanvas`) и число расхождений. */
export function mergeCanvasTexts(base: string, mine: string, theirs: string): CanvasMergeResult {
  const result = engineStatic<EngineMerge>('notesCanvasMerge', { base, mine, theirs });
  return { text: serializeCanvas(parseCanvas(JSON.stringify(result.doc)).doc), conflicts: result.conflicts };
}
