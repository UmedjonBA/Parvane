// Одна заметка с двух устройств: построчное трёхстороннее слияние с общей версией. Правки разных мест
// складываются, одинаковые берутся один раз. Если одно место изменено по-разному — конфликт: текст остаётся
// «моим» без меток, а «их» версию вызывающий сохраняет отдельной копией.

export type NotesMergeResult = { text: string; hasConflict: boolean };

// Таблица сравнения растёт как произведение длин; больше — не сравниваем построчно
const MAX_DIFF_CELLS = 4_000_000;
const NO_MATCH = -1;

export function mergeNotes(base: string, mine: string, theirs: string): NotesMergeResult {
  const baseText = normalizeEol(base);
  const mineText = normalizeEol(mine);
  const theirsText = normalizeEol(theirs);
  if (mineText === theirsText || theirsText === baseText) return { text: mineText, hasConflict: false };
  if (mineText === baseText) return { text: theirsText, hasConflict: false };

  const baseLines = splitLines(baseText);
  const mineLines = splitLines(mineText);
  const theirsLines = splitLines(theirsText);
  const mineMatch = matchLines(baseLines, mineLines);
  const theirsMatch = matchLines(baseLines, theirsLines);
  const conflict = { text: mineText, hasConflict: true };
  if (!mineMatch || !theirsMatch) return conflict;

  const merged: string[] = [];
  let baseAt = 0;
  let mineAt = 0;
  let theirsAt = 0;
  while (baseAt < baseLines.length || mineAt < mineLines.length || theirsAt < theirsLines.length) {
    // Общий участок: строки основы стоят на своих местах у обеих сторон
    let stable = 0;
    while (
      baseAt + stable < baseLines.length
      && mineMatch[baseAt + stable] === mineAt + stable
      && theirsMatch[baseAt + stable] === theirsAt + stable
    ) stable++;
    if (stable) {
      merged.push(...baseLines.slice(baseAt, baseAt + stable));
      baseAt += stable;
      mineAt += stable;
      theirsAt += stable;
      continue;
    }

    // Изменённый участок тянется до ближайшей строки основы, уцелевшей у обеих сторон
    let baseEnd = baseAt;
    while (baseEnd < baseLines.length && (mineMatch[baseEnd] === NO_MATCH || theirsMatch[baseEnd] === NO_MATCH)) {
      baseEnd++;
    }
    const mineEnd = baseEnd < baseLines.length ? mineMatch[baseEnd] : mineLines.length;
    const theirsEnd = baseEnd < baseLines.length ? theirsMatch[baseEnd] : theirsLines.length;
    const basePart = baseLines.slice(baseAt, baseEnd);
    const minePart = mineLines.slice(mineAt, mineEnd);
    const theirsPart = theirsLines.slice(theirsAt, theirsEnd);

    if (areEqual(theirsPart, basePart) || areEqual(minePart, theirsPart)) merged.push(...minePart);
    else if (areEqual(minePart, basePart)) merged.push(...theirsPart);
    else return conflict;

    baseAt = baseEnd;
    mineAt = mineEnd;
    theirsAt = theirsEnd;
  }

  const hasFinalEol = mineText.endsWith('\n') && merged.length > 0;
  return { text: merged.join('\n') + (hasFinalEol ? '\n' : ''), hasConflict: false };
}

function normalizeEol(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

// Завершающий перевод строки — не отдельная пустая строка
function splitLines(text: string) {
  if (!text) return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function areEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * Наибольшая общая подпоследовательность строк: для каждой строки `from` — номер парной строки в `to`
 * либо `NO_MATCH`. Слишком большие тексты не сравниваются — `undefined`.
 */
function matchLines(from: string[], to: string[]) {
  const match = new Array<number>(from.length).fill(NO_MATCH);
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) {
    match[head] = head;
    head++;
  }
  let tail = 0;
  while (
    tail < from.length - head && tail < to.length - head
    && from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) {
    match[from.length - 1 - tail] = to.length - 1 - tail;
    tail++;
  }

  const rows = from.length - head - tail;
  const columns = to.length - head - tail;
  if (!rows || !columns) return match;
  if (rows * columns > MAX_DIFF_CELLS) return undefined;

  // `lengths[row * width + column]` — длина общей части хвостов `from[head + row…]` и `to[head + column…]`
  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      lengths[row * width + column] = from[head + row] === to[head + column]
        ? lengths[(row + 1) * width + column + 1] + 1
        : Math.max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
    }
  }

  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (from[head + row] === to[head + column]) {
      match[head + row] = head + column;
      row++;
      column++;
    } else if (lengths[(row + 1) * width + column] >= lengths[row * width + column + 1]) {
      row++;
    } else {
      column++;
    }
  }
  return match;
}
