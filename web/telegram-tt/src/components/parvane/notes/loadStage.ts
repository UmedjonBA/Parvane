// Стадии долгой загрузки модуля (доска `ZdMisc`): сначала заглушки, дольше трёх секунд — подпись «Загрузка…»,
// дольше десяти — «Нет ответа от сервера» и «Повторить»
export type LoadStage = 'loading' | 'slow' | 'noAnswer';

export const SLOW_AFTER_MS = 3000;
export const NO_ANSWER_AFTER_MS = 10000;

/** Отсчёт стадий с начала загрузки; «нет ответа» — только там, где есть чем повторить. Возвращает отмену. */
export function watchLoadStage(onStage: (stage: LoadStage) => void, canGiveUp?: boolean) {
  const timers = [setTimeout(() => onStage('slow'), SLOW_AFTER_MS)];
  if (canGiveUp) timers.push(setTimeout(() => onStage('noAnswer'), NO_ANSWER_AFTER_MS));
  return () => timers.forEach((timer) => clearTimeout(timer));
}
