import type { HealthDraft, HealthEntry } from './healthTypes';

import { parseNumber } from './healthFormat';

// Parvane (spec 041 B3): питание и тренировки «Здоровья» — подписи приёмов и типов, темп, поля формы записи.
// Итоги дня, недели и закрытый день считает движок (`healthView`: `nutrition`, `activity`)

export const FOOD_KIND = 'food';
export const WORKOUT_KIND = 'workout';
export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;
export const WORKOUT_TAGS = ['strength', 'run', 'walk', 'bike', 'swim', 'yoga', 'other'] as const;
export const MACROS = ['kcal', 'protein', 'fat', 'carbs'] as const;
export type HealthMacro = typeof MACROS[number];

const SECONDS_IN_MINUTE = 60;

const MEAL_KEYS = {
  breakfast: 'HealthMealBreakfast',
  lunch: 'HealthMealLunch',
  dinner: 'HealthMealDinner',
  snack: 'HealthMealSnack',
  other: 'HealthMealOther',
} as const;

const WORKOUT_KEYS = {
  strength: 'HealthWorkoutStrength',
  run: 'HealthWorkoutRun',
  walk: 'HealthWorkoutWalk',
  bike: 'HealthWorkoutBike',
  swim: 'HealthWorkoutSwim',
  yoga: 'HealthWorkoutYoga',
  other: 'HealthWorkoutOther',
} as const;

export const MACRO_KEYS = {
  kcal: 'HealthMacroKcal',
  protein: 'HealthMacroProtein',
  fat: 'HealthMacroFat',
  carbs: 'HealthMacroCarbs',
} as const;

/** Подпись приёма пищи; незнакомый приём — «Другое». */
export function mealTitleKey(tag: string) {
  return MEAL_KEYS[tag as keyof typeof MEAL_KEYS] || MEAL_KEYS.other;
}

/** Подпись типа тренировки; незнакомый тип — «Тренировка». */
export function workoutTitleKey(tag: string) {
  return WORKOUT_KEYS[tag as keyof typeof WORKOUT_KEYS] || WORKOUT_KEYS.other;
}

/** Темп: секунд на километр → `5:40`. */
export function formatPace(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / SECONDS_IN_MINUTE)}:${String(total % SECONDS_IN_MINUTE).padStart(2, '0')}`;
}

/** Доля выполнения цели для полосы: без цели — пусто, перебор — полная. */
export function goalShare(value: number, goal: number | undefined) {
  return goal ? Math.max(0, Math.min(1, value / goal)) : 0;
}

/** Высота столбика дня в долях самого большого значения недели. */
export function barShares(values: (number | undefined)[], goal?: number) {
  const top = Math.max(goal || 0, ...values.map((value) => value || 0));
  return values.map((value) => (top && value ? value / top : 0));
}

// Поля окна правки сверх общих: название, приём либо тип и именованные числа
export type HealthExtraForm = {
  name: string;
  tag: string;
  protein: string;
  fat: string;
  carbs: string;
  km: string;
  exercises: string;
};

export const EMPTY_EXTRA_FORM: HealthExtraForm = {
  name: '', tag: '', protein: '', fat: '', carbs: '', km: '', exercises: '',
};

const PART_FIELDS: Record<string, (keyof HealthExtraForm)[]> = {
  [FOOD_KIND]: ['protein', 'fat', 'carbs'],
  [WORKOUT_KIND]: ['km', 'exercises'],
};

export function hasExtraFields(kind: string) {
  return kind in PART_FIELDS;
}

/** Запись → поля формы: незаданное число — пустое поле. */
export function extraFormOf(entry: Pick<HealthEntry, 'name' | 'tag' | 'parts'>): HealthExtraForm {
  const part = (key: string) => (entry.parts[key] === undefined ? '' : String(entry.parts[key]));
  return {
    name: entry.name,
    tag: entry.tag,
    protein: part('protein'),
    fat: part('fat'),
    carbs: part('carbs'),
    km: part('km'),
    exercises: part('exercises'),
  };
}

/**
 * Поля формы → название, метка и числа записи. Числа, которых в форме нет (граммы, клетчатка), остаются
 * прежними; пустое поле — число не задано. Не число в поле — `undefined`.
 */
export function extraDraftOf(
  kind: string, form: HealthExtraForm, previous: Record<string, number> = {},
): Pick<HealthDraft, 'name' | 'tag' | 'parts'> | undefined {
  const fields = PART_FIELDS[kind];
  if (!fields) return {};
  const parts = { ...previous };
  for (const field of fields) {
    const text = form[field].trim();
    if (!text) {
      delete parts[field];
      continue;
    }
    const value = parseNumber(text);
    if (value === undefined || value < 0) return undefined;
    parts[field] = value;
  }
  return { name: form.name.trim(), tag: form.tag, parts };
}
