import type { HealthEntry, HealthMetricView, HealthParsedEntry } from './healthTypes';

// Parvane (spec 038): показ значений «Здоровья» — только оформление чисел и времени. Сами значения (день
// записи, суммы, отклонения) считает движок

const MINUTES_IN_HOUR = 60;
const MINUTES_IN_DAY = 1440;
const MS_IN_MINUTE = 60000;
export const MS_IN_DAY = MINUTES_IN_DAY * MS_IN_MINUTE;

// Показатели тела в порядке плиток сводки; остальные виды идут за ними по алфавиту
export const BODY_KINDS = ['weight', 'pressure', 'pulse', 'steps'];
export const MOOD_KIND = 'mood';
export const WATER_KIND = 'water';
export const MOOD_MAX = 5;
// Блоки модуля (экран «Модули») → виды записей
export const BLOCK_KINDS: Record<string, string[]> = {
  water: ['water'],
  food: ['food', 'calories'],
  workouts: ['workout'],
};

const KIND_TITLE_KEYS = {
  sleep: 'HealthKindSleep',
  sleep_start: 'HealthKindSleepStart',
  sleep_end: 'HealthKindSleepEnd',
  weight: 'HealthKindWeight',
  pressure: 'HealthKindPressure',
  pulse: 'HealthKindPulse',
  steps: 'HealthKindSteps',
  water: 'HealthKindWater',
  mood: 'HealthKindMood',
  temperature: 'HealthKindTemperature',
  glucose: 'HealthKindGlucose',
  height: 'HealthKindHeight',
  waist: 'HealthKindWaist',
  hips: 'HealthKindHips',
  chest: 'HealthKindChest',
  body_fat: 'HealthKindBodyFat',
  spo2: 'HealthKindSpo2',
} as const;

const UNIT_KEYS = {
  kg: 'HealthUnitKg',
  mmhg: 'HealthUnitMmhg',
  bpm: 'HealthUnitBpm',
  ml: 'HealthUnitMl',
  c: 'HealthUnitCelsius',
  mmol_l: 'HealthUnitMmol',
  cm: 'HealthUnitCm',
  pct: 'HealthUnitPercent',
} as const;

export type HealthKindTitleKey = typeof KIND_TITLE_KEYS[keyof typeof KIND_TITLE_KEYS];
export type HealthUnitKey = typeof UNIT_KEYS[keyof typeof UNIT_KEYS];

export function kindTitleKey(kind: string): HealthKindTitleKey | undefined {
  return KIND_TITLE_KEYS[kind as keyof typeof KIND_TITLE_KEYS];
}

export function unitKey(unit: string): HealthUnitKey | undefined {
  return UNIT_KEYS[unit as keyof typeof UNIT_KEYS];
}

/** Минуты от полуночи → `ЧЧ:ММ`. */
export function formatClock(minutes: number) {
  const wrapped = ((Math.round(minutes) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hours = Math.floor(wrapped / MINUTES_IN_HOUR);
  return `${String(hours).padStart(2, '0')}:${String(wrapped % MINUTES_IN_HOUR).padStart(2, '0')}`;
}

/** Длительность в минутах → часы и минуты для подписи «6 ч 55 м». */
export function splitDuration(minutes: number) {
  const total = Math.max(0, Math.round(minutes));
  return { hours: Math.floor(total / MINUTES_IN_HOUR), minutes: total % MINUTES_IN_HOUR };
}

/** Короткая длительность строки недели: `7:25`. */
export function formatDurationShort(minutes: number) {
  const { hours, minutes: rest } = splitDuration(minutes);
  return `${hours}:${String(rest).padStart(2, '0')}`;
}

/** Число показателя: целые — с разделителем тысяч, дробные — одна цифра после запятой. */
export function formatNumber(value: number, locale: string) {
  const isWhole = Math.abs(value - Math.round(value)) < 0.05;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: isWhole ? 0 : 1, maximumFractionDigits: isWhole ? 0 : 1,
  }).format(isWhole ? Math.round(value) : value);
}

/** Значение записи: давление — парой `120/80`, вес — всегда с десятой. */
export function formatValue(entry: Pick<HealthEntry, 'kind' | 'value' | 'value2'>, locale: string) {
  if (entry.kind === 'pressure') return `${Math.round(entry.value)}/${Math.round(entry.value2)}`;
  if (entry.kind === 'weight' || entry.kind === 'temperature') {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(entry.value);
  }
  return formatNumber(entry.value, locale);
}

/** Изменение со знаком: `−0,6`, `+1,2`; ноль — без знака. */
export function formatDelta(value: number, locale: string) {
  const text = formatNumber(Math.abs(value), locale);
  if (Math.abs(value) < 0.05) return text;
  return `${value < 0 ? '−' : '+'}${text}`;
}

/** Местное время записи `ЧЧ:ММ` по её смещению. */
export function entryClock(entry: Pick<HealthEntry, 'atMs' | 'tzMin'>) {
  return formatClock(Math.floor((entry.atMs + entry.tzMin * 60000) / 60000));
}

/** Порядок плиток: показатели тела в заданном порядке, прочие — по алфавиту вида. */
export function orderMetrics(metrics: HealthMetricView[]) {
  const rank = (kind: string) => {
    const index = BODY_KINDS.indexOf(kind);
    return index < 0 ? BODY_KINDS.length : index;
  };
  return metrics.slice().sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind));
}

/** Точки ломаной графика в рамке `width × height`: значения растянуты между минимумом и максимумом ряда. */
export function buildSparkline(values: number[], width: number, height: number, padding = 2) {
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;
  return values.map((value, index) => {
    const x = padding + step * index;
    const y = padding + (height - padding * 2) * (1 - (value - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** Полоса сна на шкале суток «с 20:00 до 12:00»: доли ширины для начала и длины. */
export function sleepBar(bedMin: number, wakeMin: number) {
  const axisStart = 20 * MINUTES_IN_HOUR;
  const axisSpan = 16 * MINUTES_IN_HOUR;
  const from = ((bedMin - axisStart) % MINUTES_IN_DAY + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const length = ((wakeMin - bedMin) % MINUTES_IN_DAY + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const left = Math.min(1, from / axisSpan);
  return { left, width: Math.max(0, Math.min(1 - left, length / axisSpan)) };
}

/** Одна строка «как понято» для разобранной записи: значение без подписи вида. */
export function parsedValue(entry: HealthParsedEntry, locale: string) {
  if (entry.kind === 'sleep' && entry.endMs) return `${entry.time} → ${entry.endTime}`;
  if (entry.kind === 'sleep') return formatDurationShort(entry.value);
  if (entry.kind === 'sleep_start' || entry.kind === 'sleep_end') return entry.time;
  return formatValue(entry, locale);
}

/** Ключ дня `ГГГГ-ММ-ДД` по местному времени устройства. */
export function localDayKey(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Каким словом назвать день относительно сегодняшнего: сегодня, вчера либо дата. */
export function dayRelation(day: string, today: string): 'today' | 'yesterday' | 'date' {
  if (day === today) return 'today';
  const previous = new Date(`${today}T12:00:00`);
  previous.setDate(previous.getDate() - 1);
  return day === localDayKey(previous) ? 'yesterday' : 'date';
}

/** Момент → день `ГГГГ-ММ-ДД` и время `ЧЧ:ММ` в поясе записи (поля формы). */
export function toLocalParts(ms: number, tzMin: number) {
  const iso = new Date(ms + tzMin * MS_IN_MINUTE).toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** День и время полей формы в поясе записи → момент; негодный ввод — `undefined`. */
export function fromLocalParts(day: string, time: string, tzMin: number) {
  const ms = Date.parse(`${day}T${time}:00Z`);
  return Number.isFinite(ms) ? ms - tzMin * MS_IN_MINUTE : undefined;
}

/** Отрезок сна по дню пробуждения: «лёг» позже «встал» по часам — лёг накануне. */
export function buildSleepSpan(wakeDay: string, bedTime: string, wakeTime: string, tzMin: number) {
  const endMs = fromLocalParts(wakeDay, wakeTime, tzMin);
  const sameDayStart = fromLocalParts(wakeDay, bedTime, tzMin);
  if (endMs === undefined || sameDayStart === undefined) return undefined;
  const atMs = sameDayStart < endMs ? sameDayStart : sameDayStart - MS_IN_DAY;
  return { atMs, endMs, minutes: Math.round((endMs - atMs) / MS_IN_MINUTE) };
}

/** Число из поля формы: запятая и точка равноправны; не число — `undefined`. */
export function parseNumber(text: string) {
  const cleaned = text.trim().replace(',', '.');
  const value = cleaned ? Number(cleaned) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** Время поля `ЧЧ:ММ` → минуты от полуночи (оно же — длительность до суток); негодный ввод — `undefined`. */
export function parseClock(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * MINUTES_IN_HOUR + minutes : undefined;
}
