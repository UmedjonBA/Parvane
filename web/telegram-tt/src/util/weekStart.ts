import { createSignal } from './signals';

// «Первый день недели» в «Языке» (доски `RpProfileA`, `ZdProfileX`): с какого дня «План» строит неделю и сетку месяца.
// Настройка устройства; значение — номер дня как у `Date.getDay` (1 — понедельник, 0 — воскресенье, 6 — суббота).
// Повторы «по понедельникам» и т. п. от неё не зависят
export type FirstWeekday = 0 | 1 | 6;

export const FIRST_WEEKDAYS: FirstWeekday[] = [1, 0, 6];

const STORAGE_KEY = 'parvane:first-weekday';
const DAYS_IN_WEEK = 7;

const [getFirstWeekday, setFirstWeekdaySignal] = createSignal<FirstWeekday>(readFirstWeekday());

export { getFirstWeekday };

export function setFirstWeekday(value: FirstWeekday) {
  setFirstWeekdaySignal(value);
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Настройка действует до перезагрузки
  }
}

/** Место дня (`Date.getDay`) в неделе, начатой с `first`: 0 — первый день. */
export function getWeekPosition(weekday: number, first: FirstWeekday = getFirstWeekday()) {
  return (weekday - first + DAYS_IN_WEEK) % DAYS_IN_WEEK;
}

/** Дни недели по порядку показа — номерами с понедельника (0 — понедельник), как их ждёт `formatWeekday`. */
export function getWeekdayOrder(first: FirstWeekday = getFirstWeekday()) {
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) => (first + i + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK);
}

function readFirstWeekday(): FirstWeekday {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY) ?? 1);
    return FIRST_WEEKDAYS.includes(value as FirstWeekday) ? value as FirstWeekday : 1;
  } catch {
    return 1;
  }
}
