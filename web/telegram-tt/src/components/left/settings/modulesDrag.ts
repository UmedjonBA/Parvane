// Parvane: перетаскивание строки на экране «Профиль → Модули» — куда встанет перетаскиваемый модуль.
// Чистая часть: по середине остальных строк и положению указателя; сам порядок меняет движок (`modulesMove`)

/**
 * Новое место строки: столько, сколько остальных строк (без перетаскиваемой) лежит выше указателя по их середине.
 * `middles` — середины остальных строк сверху вниз.
 */
export function findDropIndex(middles: number[], pointerY: number) {
  let index = 0;
  for (const middle of middles) {
    if (pointerY <= middle) break;
    index++;
  }
  return index;
}

/** Стрелка с клавиатуры на ручке: на строку выше либо ниже, в пределах списка; на месте — `undefined`. */
export function findKeyMoveIndex(index: number, key: string, count: number) {
  const target = key === 'ArrowUp' ? index - 1 : key === 'ArrowDown' ? index + 1 : index;
  if (target === index || target < 0 || target >= count) return undefined;
  return target;
}
