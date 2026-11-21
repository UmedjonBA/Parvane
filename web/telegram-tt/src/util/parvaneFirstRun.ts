import { createSignal } from './signals';

// Parvane: первый запуск «Что вам нужно в Parvane?» (доски `XpStart`, `ZdNav`) — выбор модулей один раз на
// устройство. Отметка — настройка устройства (переживает стирание аккаунта, `deviceWipe.ts`), как и набор модулей

const FIRST_RUN_KEY = 'parvane:modules-first-run';
const FIRST_RUN_DONE = 'shown';
// Шагов регистрации: экран ключа восстановления — последний из них («шаг 3 из 3»). Только во вкладке регистрации
const REGISTER_STEPS_KEY = 'parvane:register-steps';
// Модули, которые лента телефона показывает без прокрутки (`ParvaneTabBar`, `MAX_FIT_MODULES`)
const RIBBON_FIT_MODULES = 5;

function readFirstRunDone() {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) === FIRST_RUN_DONE;
  } catch {
    return true;
  }
}

const [getIsFirstRunDone, setIsFirstRunDone] = createSignal(readFirstRunDone());

export { getIsFirstRunDone };

export function markFirstRunDone() {
  try {
    localStorage.setItem(FIRST_RUN_KEY, FIRST_RUN_DONE);
  } catch {
    // Без хранилища экран покажется и при следующем запуске
  }
  setIsFirstRunDone(true);
}

export function markRegistrationSteps(total: number) {
  try {
    sessionStorage.setItem(REGISTER_STEPS_KEY, String(total));
  } catch {
    // Номер шага не покажется
  }
}

/** Шагов регистрации, начатой в этой вкладке; после сброса личности и входа — `undefined`. */
export function readRegistrationSteps(): number | undefined {
  try {
    const total = Number(sessionStorage.getItem(REGISTER_STEPS_KEY));
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

export function clearRegistrationSteps() {
  try {
    sessionStorage.removeItem(REGISTER_STEPS_KEY);
  } catch {
    // Нечего снимать
  }
}

/** Подпись счётчика выбора: сколько модулей включено из всех и поместится ли лента без прокрутки. */
export function describeFirstRunCount(selected: number, total: number) {
  return { selected, total, doesFit: selected <= RIBBON_FIT_MODULES };
}
