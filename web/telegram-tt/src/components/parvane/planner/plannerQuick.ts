// Ввод текстом (spec 017): одна строка → черновик записи «Плана». Чистая функция без сети: распознаватели
// по очереди помечают свои участки строки, название — всё непомеченное. Слова разбора — словарь русского
// языка; другой язык добавляется таким же набором выражений.

import type {
  PlannerEventError, PlannerMeal, PlannerNutrient, PlannerRepeat, PlannerRepeatKind, PlannerTaskError,
} from './plannerModel';

import {
  addDays, DEFAULT_EVENT_MINUTES, fromDayKey, MINUTES_IN_DAY, toDayKey, toTime, validateEvent,
  validateRepeat, validateTask,
} from './plannerModel';

export type QuickKind = 'task' | 'event' | 'food' | 'water';
export type QuickField =
  'kind' | 'day' | 'time' | 'minutes' | 'due' | 'repeat' | 'meal' | 'grams' | 'water' | PlannerNutrient;
export type QuickSpan = { field: QuickField; from: number; to: number };
export type QuickError = PlannerTaskError | PlannerEventError;

export type QuickDraft = {
  kind: QuickKind;
  name: string;
  day?: string;
  // День не назван: взят сегодняшний либо завтрашний (время уже прошло)
  isDayAssumed?: boolean;
  start?: string;
  end?: string;
  isAllDay?: boolean;
  minutes?: number;
  due?: string;
  repeat?: PlannerRepeat;
  meal?: PlannerMeal;
  grams?: number;
  nutrients?: Partial<Record<PlannerNutrient, number>>;
  waterMl?: number;
  spans: QuickSpan[];
  error?: QuickError;
};

export type QuickContext = {
  today: string;
  // Минуты от полуночи: «время уже прошло» и приём пищи по времени суток
  nowMinutes: number;
  dayStart: number;
  dayEnd: number;
  // Тип выбран пользователем — сильнее слов строки
  kind?: QuickKind;
  // Типы, которые разбор вправе выбрать сам (по умолчанию все)
  kinds?: QuickKind[];
  // Значения, снятые пользователем: их слова остаются в названии
  skip?: QuickField[];
};

export const QUICK_TASK_MINUTES = 30;
const GLASS_ML = 250;
const MINUTES_IN_HOUR = 60;

const ALNUM = 'a-zа-я0-9';
const NUM = '\\d+(?:[.,]\\d+)?';
const HOUR = '[01]?\\d|2[0-4]';
const DAYPART = 'утра|дня|вечера|ночи';
const WEEKDAY = 'пн|вт|ср|чт|пт|сб|вс|понедельник(?:а|у|ам|и)?|вторник(?:а|у|ам|и)?|сред(?:а|у|ы|ам)'
  + '|четверг(?:а|у|ам|и)?|пятниц(?:а|у|ы|ам)|суббот(?:а|у|ы|ам)|воскресень(?:е|я|ям)';
const MONTH = 'январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]'
  + '|ноябр[ья]|декабр[ья]';
const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DATE = 'сегодня|завтра|послезавтра|через\\s+(?:\\d+\\s+)?(?:день|дня|дней|недел[юиь])'
  + `|на\\s+следующей\\s+неделе|\\d{1,2}\\.\\d{2}(?:\\.\\d{4}|\\.\\d{2})?|\\d{1,2}\\s+(?:${MONTH})`
  + `|(?:во?\\s+)?(?:${WEEKDAY})`;
const MEALS: Record<string, PlannerMeal> = {
  завтрак: 'breakfast', обед: 'lunch', ужин: 'dinner', перекус: 'snack',
};
const SMALL_NUMBERS: Record<string, number> = { две: 2, два: 2, три: 3, четыре: 4 };

type Groups = (string | undefined)[];

// Граница слова: `\b` в регулярных выражениях JS не знает кириллицы, а просмотр назад есть не во всех
// браузерах — поэтому символ перед словом захватывается первой группой и в совпадение не входит
function word(body: string) {
  return new RegExp(`(^|[^${ALNUM}])(${body})(?![${ALNUM}])`, 'g');
}

function toNumber(value: string) {
  return Number(value.replace(',', '.'));
}

function weekdayOf(text: string) {
  const key = text.replace(/^во?\s+/, '').slice(0, 2);
  return {
    пн: 1, по: 1, вт: 2, ср: 3, чт: 4, че: 4, пт: 5, пя: 5, сб: 6, су: 6, вс: 0, во: 0,
  }[key];
}

function monthOf(text: string) {
  // «ма» (май) проверяется после «мар» (март)
  return MONTH_STEMS.findIndex((stem) => text.startsWith(stem)) + 1;
}

function addMonths(day: string, months: number) {
  const date = fromDayKey(day);
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return toDayKey(target);
}

// Ближайшая будущая дата с таким числом и месяцем (сегодня считается)
function nearestDate(today: string, month: number, dayOfMonth: number, year?: number) {
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return undefined;
  const build = (y: number) => {
    const date = new Date(y, month - 1, dayOfMonth);
    return date.getMonth() === month - 1 ? toDayKey(date) : undefined;
  };
  if (year !== undefined) return build(year < 100 ? 2000 + year : year);
  const thisYear = fromDayKey(today).getFullYear();
  const day = build(thisYear);
  return day && day >= today ? day : build(thisYear + 1);
}

function nextWeekday(from: string, weekday: number, isTodayCounted: boolean) {
  const delta = (weekday - fromDayKey(from).getDay() + 7) % 7;
  return addDays(from, delta || (isTodayCounted ? 0 : 7));
}

function resolveDate(text: string, today: string): string | undefined {
  if (text === 'сегодня') return today;
  if (text === 'завтра') return addDays(today, 1);
  if (text === 'послезавтра') return addDays(today, 2);
  if (text.startsWith('через')) {
    const count = Number(/\d+/.exec(text)?.[0] || 1);
    return addDays(today, /недел/.test(text) ? count * 7 : count);
  }
  if (text.startsWith('на ')) return nextWeekday(today, 1, false);
  const dotted = /^(\d{1,2})\.(\d{2})(?:\.(\d{2,4}))?$/.exec(text);
  if (dotted) {
    return nearestDate(today, Number(dotted[2]), Number(dotted[1]), dotted[3] ? Number(dotted[3]) : undefined);
  }
  const named = /^(\d{1,2})\s+(\S+)$/.exec(text);
  if (named) return nearestDate(today, monthOf(named[2]), Number(named[1]));
  const weekday = weekdayOf(text);
  if (weekday !== undefined) return nextWeekday(today, weekday, false);
  // «до марта»: первый день месяца
  const month = monthOf(text);
  return month ? nearestDate(today, month, 1) : undefined;
}

function resolveHour(hour: number, minute: number, daypart?: string) {
  if (hour > 24 || minute > 59 || (hour === 24 && minute)) return undefined;
  let h = hour;
  if (daypart === 'вечера' || daypart === 'дня') {
    if (h < 12) h += 12;
  } else if (daypart === 'ночи') {
    if (h === 12) h = 0;
    else if (h >= 9 && h < 12) h += 12;
  } else if (daypart === 'утра') {
    if (h === 12) h = 0;
  }
  return h * MINUTES_IN_HOUR + minute;
}

// «в 5» без уточнения — значение внутри окна дня; оба подходят либо ни одно — как написано
function resolveBareHour(hour: number, ctx: QuickContext) {
  const morning = hour * MINUTES_IN_HOUR;
  const evening = morning + 12 * MINUTES_IN_HOUR;
  const isInside = (value: number) => value >= ctx.dayStart && value <= ctx.dayEnd;
  return hour <= 11 && !isInside(morning) && isInside(evening) ? evening : morning;
}

function mealByTime(minutes: number): PlannerMeal {
  if (minutes < 11 * MINUTES_IN_HOUR) return 'breakfast';
  if (minutes < 16 * MINUTES_IN_HOUR) return 'lunch';
  if (minutes < 22 * MINUTES_IN_HOUR) return 'dinner';
  return 'snack';
}

export function parseQuickInput(text: string, ctx: QuickContext): QuickDraft {
  const folded = text.toLowerCase().replace(/ё/g, 'е');
  // Свёртка регистра обязана сохранять позиции символов: участки меряются по исходной строке
  const lower = folded.length === text.length ? folded : text;
  const taken = new Array<boolean>(text.length).fill(false);
  const spans: QuickSpan[] = [];
  const skipped = new Set(ctx.skip);
  const allowed = new Set<QuickKind>(ctx.kind ? [ctx.kind] : (ctx.kinds || ['task', 'event', 'food', 'water']));

  const mark = (field: QuickField, from: number, to: number) => {
    for (let i = from; i < to; i++) taken[i] = true;
    spans.push({ field, from, to });
  };

  // Совпадения по порядку; занятый участок пропускается. `handle` возвращает false — «не моё»
  const scan = (
    field: QuickField, body: string, handle: (groups: Groups, from: number, to: number) => boolean | void,
    isOnce = true,
  ) => {
    if (skipped.has(field)) return;
    const re = word(body);
    let match = re.exec(lower);
    while (match) {
      const from = match.index + match[1].length;
      const to = from + match[2].length;
      re.lastIndex = to;
      const isFree = !taken.slice(from, to).some(Boolean);
      if (isFree && handle(match.slice(2), from, to) !== false) {
        mark(field, from, to);
        if (isOnce) return;
      }
      match = re.exec(lower);
    }
  };

  const draft: QuickDraft = { kind: 'task', name: '', spans };
  let explicitKind = ctx.kind;

  // ── слова-типы в начале строки ─────────────────────────────────────────────
  if (!explicitKind) {
    const lead = /^\s*(задач[ау]|событие)\s*[:—–-]?\s*/.exec(lower);
    const leadKind: QuickKind | undefined = lead ? (lead[1] === 'событие' ? 'event' : 'task') : undefined;
    if (lead && leadKind && allowed.has(leadKind) && !skipped.has('kind')) {
      explicitKind = leadKind;
      mark('kind', 0, lead[0].length);
    }
  }

  // ── числа с единицами: питание и вода ─────────────────────────────────────
  const nutrients: Partial<Record<PlannerNutrient, number>> = {};
  if (allowed.has('food') && explicitKind !== 'water') {
    scan('kcal', `(${NUM})\\s*(?:ккал|кал)`, (g) => {
      nutrients.kcal = toNumber(g[1]!);
    });
    const macros: [PlannerNutrient, string][] = [
      ['protein', 'б|белк[иа]|белок'], ['fat', 'ж|жир[ыа]?'], ['carbs', 'у|углевод[ыа]?'],
      ['fiber', 'кл|клетчатк[аи]'],
    ];
    macros.forEach(([nutrient, names]) => {
      scan(nutrient, `(?:${names})\\s*(${NUM})(?:\\s*г)?`, (g) => {
        nutrients[nutrient] = toNumber(g[1]!);
      });
    });
  }
  const isFood = explicitKind === 'food' || (!explicitKind && Object.keys(nutrients).length > 0);
  if (isFood) {
    scan('grams', `(${NUM})\\s*(?:г|гр|грамм(?:а|ов)?)`, (g) => {
      draft.grams = toNumber(g[1]!);
    });
    scan('meal', Object.keys(MEALS).join('|'), (g) => {
      draft.meal = MEALS[g[0]!];
    });
  }

  let isWater = false;
  if (!isFood && allowed.has('water') && (!explicitKind || explicitKind === 'water')) {
    const lead = /^\s*вод[аыу]\s*/.exec(lower);
    const volume = `(${NUM})\\s*(мл|л|литр(?:а|ов)?|стакан(?:а|ов)?)`;
    const found = word(volume).exec(lower);
    const rest = found ? lower.slice(lead?.[0].length || 0).replace(found[2], '').trim() : 'x';
    // Вода — слово «вода» в начале либо один объём без других слов
    if (found && (lead || explicitKind === 'water' || !rest)) {
      scan('water', volume, (g) => {
        const amount = toNumber(g[1]!);
        const unit = g[2]!;
        draft.waterMl = Math.round(amount * (unit === 'мл' ? 1 : unit.startsWith('стакан') ? GLASS_ML : 1000));
      });
      if (lead) mark('kind', 0, lead[0].length);
      isWater = draft.waterMl !== undefined;
    }
    if (explicitKind === 'water') isWater = true;
  }

  // ── длительность ──────────────────────────────────────────────────────────
  if (!isFood && !isWater) {
    scan('minutes', 'полтора\\s+часа|полчаса', (g) => {
      draft.minutes = g[0] === 'полчаса' ? 30 : 90;
    });
    if (draft.minutes === undefined) {
      scan('minutes', `(${NUM})\\s*(?:ч|час(?:а|ов)?)(?:\\s*(\\d{1,2})\\s*(?:м|мин|минут[аы]?))?`, (g) => {
        draft.minutes = Math.round(toNumber(g[1]!) * MINUTES_IN_HOUR) + Number(g[2] || 0);
      });
    }
    if (draft.minutes === undefined) {
      scan('minutes', '(\\d{1,4})\\s*(?:м|мин|минут[аы]?)', (g) => {
        draft.minutes = Number(g[1]);
      });
    }
  }

  // ── время: диапазон, затем одно значение ──────────────────────────────────
  let start: number | undefined;
  let end: number | undefined;
  if (!isWater) {
    scan('time', `(с\\s+)?(${HOUR})(?::([0-5]\\d))?\\s*(?:-|–|—|до)\\s*(${HOUR})(?::([0-5]\\d))?`, (g) => {
      // «10-12» без «с» и без минут — не время (счёт, номер, диапазон чего угодно)
      if (!g[1] && g[3] === undefined && g[5] === undefined) return false;
      const from = resolveHour(Number(g[2]), Number(g[3] || 0));
      const to = resolveHour(Number(g[4]), Number(g[5] || 0));
      if (from === undefined || to === undefined) return false;
      start = from;
      end = to;
      return true;
    });
    if (start === undefined) {
      scan('time', `(?:в\\s+)?(${HOUR}):([0-5]\\d)(?:\\s*(${DAYPART}))?`, (g) => {
        start = resolveHour(Number(g[1]), Number(g[2]), g[3]);
        return start !== undefined;
      });
    }
    if (start === undefined) {
      scan('time', `в\\s+(${HOUR})(?![.:,]\\d)(?:\\s*(${DAYPART}))?`, (g) => {
        start = g[2] ? resolveHour(Number(g[1]), 0, g[2]) : resolveBareHour(Number(g[1]), ctx);
        return start !== undefined;
      });
    }
  }

  // ── повтор ────────────────────────────────────────────────────────────────
  let repeatKind: PlannerRepeatKind | undefined;
  let interval = 1;
  let weekdays: number[] | undefined;
  let endDay: string | undefined;
  let count: number | undefined;
  let spanMonths = 0;
  let spanWeeks = 0;
  if (!isFood && !isWater && !skipped.has('repeat')) {
    const unitKind = (unit: string): PlannerRepeatKind => (
      unit.startsWith('д') ? 'daily' : unit.startsWith('н') ? 'weekly' : unit.startsWith('м') ? 'monthly' : 'yearly'
    );
    scan('repeat', `кажд(?:ый|ую|ое|ые)\\s+(?:(\\d{1,2})\\s+)?(день|дня|дней|недел[юиь]|месяц(?:а|ев)?|года?|лет)`,
      (g) => {
        repeatKind = unitKind(g[2]!);
        interval = Number(g[1] || 1);
      });
    if (!repeatKind) {
      scan('repeat', `кажд(?:ый|ую|ое)\\s+(${WEEKDAY})`, (g) => {
        repeatKind = 'weekly';
        weekdays = [weekdayOf(g[1]!)!];
      });
    }
    if (!repeatKind) {
      scan('repeat', 'ежедневно|еженедельно|ежемесячно|ежегодно', (g) => {
        repeatKind = ({
          ежедневно: 'daily', еженедельно: 'weekly', ежемесячно: 'monthly', ежегодно: 'yearly',
        } as const)[g[0]!];
      });
    }
    if (!repeatKind) {
      scan('repeat', 'раз\\s+в\\s+(?:(\\d{1,2}|две|два|три|четыре)\\s+)?(недел[юиь]|месяц(?:а|ев)?)', (g) => {
        repeatKind = unitKind(g[2]!);
        interval = g[1] ? (SMALL_NUMBERS[g[1]] || Number(g[1])) : 1;
      });
    }
    const pickDays = (days: number[]) => {
      if (repeatKind && repeatKind !== 'weekly') return false;
      repeatKind = 'weekly';
      weekdays = days;
      return true;
    };
    if (!weekdays) scan('repeat', 'по\\s+будням', () => pickDays([1, 2, 3, 4, 5]));
    if (!weekdays) scan('repeat', 'по\\s+выходным', () => pickDays([6, 0]));
    if (!weekdays) {
      scan('repeat', `по\\s+(?:${WEEKDAY})(?:(?:\\s*,\\s*|\\s+и\\s+)(?:${WEEKDAY}))*`, (g) => {
        const days = g[0]!.replace(/^по\s+/, '').split(/\s*,\s*|\s+и\s+/).map((name) => weekdayOf(name)!);
        return pickDays([...new Set(days)]);
      });
    }
    if (repeatKind) {
      scan('repeat', `до\\s+(${DATE}|${MONTH})`, (g) => {
        endDay = resolveDate(g[1]!, ctx.today);
        return Boolean(endDay);
      });
      scan('repeat', '(\\d{1,3})\\s*раза?', (g) => {
        count = Number(g[1]);
      });
      scan('repeat', '(\\d{1,2})\\s*(мес|месяц(?:а|ев)?|нед|недел[иья]|года?|лет)', (g) => {
        const amount = Number(g[1]);
        if (g[2]!.startsWith('м')) spanMonths = amount;
        else if (g[2]!.startsWith('н')) spanWeeks = amount;
        else spanMonths = amount * 12;
      });
    }
  }

  // ── срок и дата ───────────────────────────────────────────────────────────
  let day: string | undefined;
  let namedWeekday: number | undefined;
  if (!isWater) {
    if (!isFood) {
      scan('due', `до\\s+(${DATE}|${MONTH})`, (g) => {
        draft.due = resolveDate(g[1]!, ctx.today);
        return Boolean(draft.due);
      });
    }
    scan('day', `(?:на\\s+|во?\\s+)?(${DATE})`, (g, from) => {
      const value = g[1]!;
      const weekday = /^\d|^сегодня|^завтра|^послезавтра|^через|^на /.test(value) ? undefined : weekdayOf(value);
      // «1000 Вт» — не вторник: день недели сразу после числа не распознаётся
      if (weekday !== undefined && /\d\s*$/.test(lower.slice(0, from))) return false;
      day = resolveDate(value, ctx.today);
      if (!day) return false;
      namedWeekday = weekday;
      return true;
    });
  }

  // ── название: всё непомеченное ────────────────────────────────────────────
  draft.name = [...text].map((char, i) => (taken[i] ? ' ' : char)).join('')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;])/g, '$1')
    .replace(/^[\s,;.:—–-]+|[\s,;:—–-]+$/g, '');
  spans.sort((a, b) => a.from - b.from);

  // ── вода и еда ────────────────────────────────────────────────────────────
  if (isWater) {
    draft.kind = 'water';
    draft.day = ctx.today;
    if (draft.waterMl === undefined) draft.error = 'name';
    return draft;
  }
  if (isFood) {
    draft.kind = 'food';
    draft.day = day || ctx.today;
    draft.meal = draft.meal || mealByTime(start ?? ctx.nowMinutes);
    if (nutrients.kcal === undefined) {
      const { protein, fat, carbs } = nutrients;
      if (protein !== undefined || fat !== undefined || carbs !== undefined) {
        nutrients.kcal = Math.round((protein || 0) * 4 + (fat || 0) * 9 + (carbs || 0) * 4);
      }
    }
    draft.nutrients = nutrients;
    if (!draft.name) {
      const meal = spans.find(({ field }) => field === 'meal');
      draft.name = meal ? text.slice(meal.from, meal.to) : '';
    }
    if (!draft.name) draft.error = 'name';
    return draft;
  }

  // ── задача либо событие ───────────────────────────────────────────────────
  const hasTime = start !== undefined;
  draft.kind = explicitKind === 'task' || explicitKind === 'event' ? explicitKind
    : hasTime && allowed.has('event') ? 'event' : 'task';
  if (!allowed.has(draft.kind)) draft.kind = allowed.has('task') ? 'task' : 'event';

  if (!day && (hasTime || draft.kind === 'event') && !repeatKind) {
    day = hasTime && start! <= ctx.nowMinutes ? addDays(ctx.today, 1) : ctx.today;
    draft.isDayAssumed = true;
  }

  if (repeatKind) {
    const base = day || ctx.today;
    if (repeatKind === 'weekly' && !weekdays) {
      weekdays = [namedWeekday ?? fromDayKey(base).getDay()];
    }
    // Начало ряда — первый подходящий день не раньше названной даты
    let startDay = base;
    if (repeatKind === 'weekly') {
      const candidates = weekdays!.map((weekday) => nextWeekday(base, weekday, true));
      startDay = candidates.sort()[0];
    }
    if (!endDay && spanMonths) endDay = addMonths(startDay, spanMonths);
    if (!endDay && spanWeeks) endDay = addDays(startDay, spanWeeks * 7);
    draft.repeat = {
      kind: repeatKind,
      interval,
      weekdays: repeatKind === 'weekly' ? [...weekdays!].sort((a, b) => a - b) : undefined,
      startDay,
      endDay,
      count,
    };
    day = startDay;
  }
  draft.day = day;

  if (draft.kind === 'event') {
    if (hasTime) {
      const finish = end ?? start! + (draft.minutes || DEFAULT_EVENT_MINUTES);
      draft.start = toTime(start!);
      // Ровно полночь — последняя минута суток; позже — ошибка, а не обрезка
      draft.end = finish === MINUTES_IN_DAY ? '23:59' : finish < MINUTES_IN_DAY ? toTime(finish) : undefined;
      draft.minutes = end !== undefined ? end - start! : draft.minutes;
    } else {
      draft.isAllDay = true;
    }
    draft.due = undefined;
    draft.error = !draft.isAllDay && !draft.end ? 'time' : validateEvent({
      name: draft.name,
      start: draft.start || '00:00',
      end: draft.end || '23:59',
      isAllDay: draft.isAllDay,
      day: draft.repeat ? undefined : draft.day,
      repeat: draft.repeat,
    });
    return draft;
  }

  if (hasTime) {
    draft.start = toTime(start!);
    draft.minutes = end !== undefined ? end - start! : (draft.minutes ?? QUICK_TASK_MINUTES);
  }
  if (draft.repeat) draft.due = undefined;
  draft.error = validateTask({
    name: draft.name, minutes: draft.minutes, day: draft.day, start: draft.start, due: draft.due,
  }) || (draft.repeat && validateRepeat(draft.repeat));
  return draft;
}
