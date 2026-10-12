// Ввод текстом (spec 017): одна строка → черновик записи «Плана». Чистая функция без сети: распознаватели
// по очереди помечают свои участки строки, название — всё непомеченное. Слова разбора лежат в словаре на
// язык (`WORDS`); порядок распознавателей и правила неоднозначности — общие для всех языков.

import type {
  PlannerEventError, PlannerExercise, PlannerGoalMetric, PlannerHealthGoals, PlannerHealthKind, PlannerMeal,
  PlannerNutrient, PlannerRepeat, PlannerRepeatKind, PlannerTaskError,
} from './plannerModel';

import {
  addDays, DEFAULT_EVENT_MINUTES, fromDayKey, MINUTES_IN_DAY, toDayKey, toTime, validateEvent,
  validateRepeat, validateTask,
} from './plannerModel';

// sleep, workout, metric — записи здоровья (spec 020); goal — правка целей и настроек, записи не создаёт
export type QuickKind = 'task' | 'event' | 'food' | 'water' | 'sleep' | 'workout' | 'metric' | 'goal';
export type QuickNutrient = PlannerNutrient | 'sugar' | 'salt';
export type QuickField =
  'kind' | 'day' | 'time' | 'minutes' | 'due' | 'repeat' | 'meal' | 'grams' | 'water' | 'health' | QuickNutrient;
// Показатель здоровья одной строкой: «вес 72,4», «давление 120/80», «пульс 64», «шаги 9500», «самочувствие 4»
export type QuickMetric = Exclude<PlannerHealthKind, 'sleep' | 'workout'>;
export type QuickGoalChanges = {
  goals: Partial<Record<PlannerGoalMetric, number>>;
  health: PlannerHealthGoals;
  dayStart?: number;
  dayEnd?: number;
  budget?: number;
};
export type QuickLang = 'ru' | 'en';
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
  nutrients?: Partial<Record<QuickNutrient, number>>;
  waterMl?: number;
  // Здоровье: показатель и его значения; у тренировки — километры и упражнения
  metric?: QuickMetric;
  value?: number;
  value2?: number;
  distanceKm?: number;
  exercises?: PlannerExercise[];
  goalChanges?: QuickGoalChanges;
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
  // Язык интерфейса (по умолчанию русский). Строка на другом языке словаря тоже разбирается — правило
  // выбора у `parseQuickInput`
  lang?: QuickLang;
};

export const QUICK_TASK_MINUTES = 30;
const GLASS_ML = 250;
const ML_IN_LITRE = 1000;
const MINUTES_IN_HOUR = 60;
const KM_IN_MILE = 1.609344;
const DAYS_IN_WEEK = 7;

const LETTER = 'a-zа-я';
const ALNUM = `${LETTER}0-9`;
const NUM = '\\d+(?:[.,]\\d+)?';
const HOUR = '[01]?\\d|2[0-4]';
const MINUTE = '[0-5]\\d';
const DASH = '-|–|—';
const ALL_KINDS: QuickKind[] = ['task', 'event', 'food', 'water', 'sleep', 'workout', 'metric', 'goal'];
const SEPARATOR = `(?![${ALNUM}])`;
const MAX_MOOD = 5;
const MIN_TYPO_LENGTH = 6;
const MAX_SLEEP_MINUTES = 16 * 60;
const MAX_STEPS = 200000;

// ── словарь языка ────────────────────────────────────────────────────────────
// Значения — тела регулярных выражений по свёрнутой строке (нижний регистр, «ё» → «е»). В телах допустимы
// только незахватывающие группы `(?:…)`: номера групп считает общий код. Пара `[тело, значение]` — слова и
// то, что они означают.
type Entry<T> = [body: string, value: T];
type Daypart = 'am' | 'pm' | 'night';
type SpanUnit = 'week' | 'month' | 'year';
type GoalWord = PlannerGoalMetric | 'sugar' | 'salt' | 'sleep' | 'weight' | 'steps' | 'day' | 'budget';

type QuickWords = {
  // Слова в начале строки: тип записи
  task: string;
  event: string;
  water: string;
  // Длинные слова разбора через пробел: слово строки с одной опечаткой заменяется словом отсюда
  typoWords: string;
  // Обычные слова, отличающиеся от слов разбора одной буквой («завтрак» — не «завтра»)
  typoSafe?: string;
  sleep: string;
  // Слова перед словом сна («сегодня я спал…») и глаголы «лёг … встал …»
  sleepPrefix?: string;
  sleepBed?: string;
  sleepWake?: string;
  workout: string;
  goal: string;
  metrics: Entry<QuickMetric>[];
  // Слова здоровья, обычные и в названиях дел («run tests», «weight of the book»): запись здоровья —
  // только если после слова разобралось значение, иначе строка идёт общим разбором
  weakLeads?: string;
  // Питание и вода
  kcal: string;
  gram: string;
  macros: Entry<QuickNutrient>[];
  // Однобуквенные обозначения, совпадающие с обычными словами («f1», «c4»): считаются, только когда в
  // строке не меньше двух признаков питания
  shortMacros?: Entry<QuickNutrient>[];
  meals: Entry<PlannerMeal>[];
  ml: string;
  litre: string;
  glass: string;
  // Длительность
  hour: string;
  minute: string;
  // Обозначение минут, которое считается только слитно с числом («45m», но не «5 m of cable»)
  minuteGlued?: string;
  halfHour: string;
  hourAndHalf: string;
  // Время
  at: string;
  from: string;
  to: string;
  dayparts: Entry<Daypart>[];
  // Уточнения, с которыми час понятен и без предлога («5pm»)
  bareDayparts?: string;
  namedTimes?: Entry<number>[];
  // Даты
  weekdays: Entry<number>[];
  weekdayLead: string;
  // Сокращения дней, совпадающие с обычными словами («sat down», «sun cream»): день — только с предлогом,
  // в конце строки либо перед числом или уже распознанным значением
  weakWeekdays?: string;
  // Окончание множественного числа дня недели: оно означает повтор и без предлога («mondays 19:00»)
  pluralWeekday?: string;
  months: Entry<number>[];
  // Месяц перед числом («Oct 12»), окончание порядкового числа и слово между числом и месяцем
  // («12th of October»)
  isMonthFirst?: boolean;
  ordinal?: string;
  of?: string;
  relative: Entry<number>[];
  in: string;
  // «in 2 days», «in a week», но не «in days»
  isInCountRequired?: boolean;
  nextWeek: string;
  dayLead: string;
  until: string;
  // Повтор. Единицы — в порядке день, неделя, месяц, год
  every: string;
  on: string;
  // Предлог с одним днём недели — всегда повтор («по вт»); иначе один день — дата («on friday»)
  isOnAlwaysRepeat?: boolean;
  and: string;
  units: Entry<PlannerRepeatKind>[];
  adverbs: Entry<PlannerRepeatKind>[];
  oncePer: string;
  workdays: string;
  weekends: string;
  times: string;
  spans: Entry<SpanUnit>[];
  spanLead?: string;
  numbers: Record<string, number>;
  // Здоровье
  kg: string;
  beats: string;
  pressureOver: string;
  distance: Entry<number>[];
  goals: Record<GoalWord, string>;
};

const WORDS: Record<QuickLang, QuickWords> = {
  ru: {
    task: 'задач[ау]',
    event: 'событие',
    water: 'вод[аыу]',
    typoWords: 'понедельник понедельника понедельникам вторник вторника вторникам средам четверг четверга четвергам'
      + ' пятница пятницу пятницы пятницам суббота субботу субботы субботам воскресенье воскресенья воскресеньям'
      + ' января февраля апреля августа сентября октября ноября декабря сегодня завтра послезавтра'
      + ' неделя неделю недели недель каждый каждую каждое каждые месяц месяца месяцев'
      + ' ежедневно еженедельно ежемесячно ежегодно будням выходным задача событие',
    typoSafe: 'завтрак завтраки неделе каждой каждого каждая месяцы выходные выходных будние задачи задачу'
      + ' события событий',
    sleep: 'сон|(?:по|про)?спал[аи]?|выспал(?:ся|ась)',
    sleepPrefix: 'сегодня|ночью|сейчас|я',
    sleepBed: 'л[её]г(?:ла)?|уснул[а]?|заснул[а]?',
    sleepWake: 'встал[а]?|проснул(?:ся|ась)',
    workout: 'зал|бег|тренировк[аиу]|кардио|плавание|йога|велосипед|прогулк[аиу]|спорт',
    goal: 'цел[ьи]',
    metrics: [
      ['вес', 'weight'], ['давление', 'pressure'], ['пульс', 'pulse'], ['шаги', 'steps'], ['самочувствие', 'mood'],
    ],
    kcal: 'ккал|кал',
    gram: 'г|гр|грамм(?:а|ов)?',
    macros: [
      ['б|белк[иа]|белок', 'protein'], ['ж|жир[ыа]?', 'fat'], ['у|углевод[ыа]?', 'carbs'],
      ['кл|клетчатк[аи]', 'fiber'], ['сахар[а]?', 'sugar'], ['сол[ьи]', 'salt'],
    ],
    meals: [['завтрак', 'breakfast'], ['обед', 'lunch'], ['ужин', 'dinner'], ['перекус', 'snack']],
    ml: 'мл',
    litre: 'л|литр(?:а|ов)?',
    glass: 'стакан(?:а|ов)?',
    hour: 'ч|час(?:а|ов)?',
    minute: 'м|мин|минут[аы]?',
    halfHour: 'полчаса',
    hourAndHalf: 'полтора\\s+часа',
    at: 'в',
    from: 'с',
    to: 'до',
    dayparts: [['утра', 'am'], ['дня|вечера', 'pm'], ['ночи', 'night']],
    weekdays: [
      ['пн|понедельник(?:а|у|ам|и)?', 1], ['вт|вторник(?:а|у|ам|и)?', 2], ['ср|сред(?:а|у|ы|ам)', 3],
      ['чт|четверг(?:а|у|ам|и)?', 4], ['пт|пятниц(?:а|у|ы|ам)', 5], ['сб|суббот(?:а|у|ы|ам)', 6],
      ['вс|воскресень(?:е|я|ям)', 0],
    ],
    weekdayLead: 'во?',
    months: [
      ['январ[ья]', 1], ['феврал[ья]', 2], ['марта?', 3], ['апрел[ья]', 4], ['ма[йя]', 5], ['июн[ья]', 6],
      ['июл[ья]', 7], ['августа?', 8], ['сентябр[ья]', 9], ['октябр[ья]', 10], ['ноябр[ья]', 11],
      ['декабр[ья]', 12],
    ],
    relative: [['сегодня', 0], ['завтра', 1], ['послезавтра', 2], ['вчера', -1]],
    in: 'через',
    nextWeek: 'на\\s+следующей\\s+неделе',
    dayLead: 'на|во?',
    until: 'до',
    every: 'кажд(?:ый|ую|ое|ые)',
    on: 'по',
    isOnAlwaysRepeat: true,
    and: 'и',
    units: [
      ['день|дня|дней', 'daily'], ['недел[юиь]', 'weekly'], ['месяц(?:а|ев)?', 'monthly'], ['года?|лет', 'yearly'],
    ],
    adverbs: [
      ['ежедневно', 'daily'], ['еженедельно', 'weekly'], ['ежемесячно', 'monthly'], ['ежегодно', 'yearly'],
    ],
    oncePer: 'раз\\s+в',
    workdays: 'по\\s+будням',
    weekends: 'по\\s+выходным',
    times: 'раза?',
    spans: [['мес|месяц(?:а|ев)?', 'month'], ['нед|недел[иья]', 'week'], ['года?|лет', 'year']],
    numbers: {
      две: 2, два: 2, три: 3, четыре: 4,
    },
    kg: 'кг',
    beats: 'уд',
    pressureOver: 'на',
    distance: [['км', 1]],
    goals: {
      kcal: 'ккал|калории|калорий',
      protein: 'белок|белки|белка',
      fat: 'жиры|жир',
      carbs: 'углеводы|углеводов',
      fiber: 'клетчатка|клетчатки',
      water: 'вод[аыу]',
      sugar: 'сахар[а]?',
      salt: 'сол[ьи]',
      sleep: 'сон',
      weight: 'вес',
      steps: 'шаги',
      day: 'день',
      budget: 'бюджет',
    },
  },
  en: {
    task: 'task|todo|to-do',
    event: 'event',
    water: 'water',
    typoWords: 'monday mondays tuesday tuesdays wednesday wednesdays thursday thursdays friday fridays saturday'
      + ' saturdays sunday sundays january february august september october november december tomorrow'
      + ' weekly monthly yearly weekdays weekends minutes',
    typoSafe: 'minute weekend weekday',
    sleep: 'sleep|slept',
    sleepPrefix: 'today|tonight|last\\s+night|i',
    sleepBed: 'went\\s+to\\s+bed|fell\\s+asleep',
    sleepWake: 'woke(?:\\s+up)?|got\\s+up',
    workout: 'gym|workout|training|cardio|run|running|jog|jogging|swim|swimming|yoga|bike|cycling|walk|hike',
    goal: 'goals?',
    metrics: [
      ['weight', 'weight'], ['pressure|bp|blood\\s+pressure', 'pressure'], ['pulse|hr|heart\\s+rate', 'pulse'],
      ['steps', 'steps'], ['mood', 'mood'],
    ],
    weakLeads: 'run|running|jog|jogging|swim|swimming|bike|cycling|walk|hike|training|cardio|yoga|steps|pressure'
      + '|blood\\s+pressure|heart\\s+rate|weight|sleep|mood|goals?',
    kcal: 'kcal|cal|calories',
    gram: 'g|gr|grams?',
    macros: [
      ['proteins?', 'protein'], ['fats?', 'fat'], ['carbs?|carbohydrates', 'carbs'], ['fiber|fibre', 'fiber'],
      ['sugar', 'sugar'], ['salt', 'salt'],
    ],
    shortMacros: [['p', 'protein'], ['f', 'fat'], ['c', 'carbs']],
    meals: [['breakfast', 'breakfast'], ['lunch', 'lunch'], ['dinner|supper', 'dinner'], ['snack', 'snack']],
    ml: 'ml|millilit(?:er|re)s?',
    litre: 'l|lit(?:er|re)s?',
    glass: 'glass(?:es)?|cups?',
    hour: 'h|hr|hrs|hours?',
    minute: 'min|mins|minutes?',
    minuteGlued: 'm',
    halfHour: 'half\\s+(?:an\\s+)?hour',
    hourAndHalf: '(?:an?\\s+|one\\s+)?hour\\s+and\\s+a\\s+half|one\\s+and\\s+a\\s+half\\s+hours?',
    at: 'at',
    from: 'from',
    to: 'to|till|until',
    dayparts: [
      ['am|a\\.m\\.|in\\s+the\\s+morning', 'am'], ['pm|p\\.m\\.|in\\s+the\\s+(?:afternoon|evening)', 'pm'],
      ['at\\s+night', 'night'],
    ],
    bareDayparts: 'am|a\\.m\\.|pm|p\\.m\\.',
    namedTimes: [['noon|midday', 12 * MINUTES_IN_HOUR], ['midnight', 0]],
    weekdays: [
      ['mon|mondays?', 1], ['tue|tues|tuesdays?', 2], ['wed|weds|wednesdays?', 3],
      ['thu|thur|thurs|thursdays?', 4], ['fri|fridays?', 5], ['sat|saturdays?', 6], ['sun|sundays?', 0],
    ],
    weekdayLead: 'next|this',
    weakWeekdays: 'sat|sun|wed',
    pluralWeekday: 'days',
    months: [
      ['jan|january', 1], ['feb|february', 2], ['mar|march', 3], ['apr|april', 4], ['may', 5], ['jun|june', 6],
      ['jul|july', 7], ['aug|august', 8], ['sep|sept|september', 9], ['oct|october', 10], ['nov|november', 11],
      ['dec|december', 12],
    ],
    isMonthFirst: true,
    ordinal: 'st|nd|rd|th',
    of: 'of',
    relative: [
      ['today', 0], ['tomorrow|tmrw', 1], ['(?:the\\s+)?day\\s+after\\s+tomorrow', 2], ['yesterday', -1],
    ],
    in: 'in',
    isInCountRequired: true,
    nextWeek: 'next\\s+week',
    dayLead: 'on|for',
    until: 'by|until|till|before|due',
    every: '(?:once\\s+)?every|each',
    on: 'on',
    and: 'and',
    units: [['days?', 'daily'], ['weeks?', 'weekly'], ['months?', 'monthly'], ['years?', 'yearly']],
    adverbs: [['daily', 'daily'], ['weekly', 'weekly'], ['monthly', 'monthly'], ['yearly|annually', 'yearly']],
    oncePer: 'once\\s+(?:a|an|per|in)',
    workdays: '(?:on\\s+)?weekdays|(?:every|each)\\s+weekday',
    weekends: '(?:on\\s+)?weekends|(?:every|each)\\s+weekend',
    times: 'times?',
    spans: [['mo|mos|months?', 'month'], ['wk|wks|weeks?', 'week'], ['yr|yrs|years?', 'year']],
    spanLead: 'for',
    numbers: {
      a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, other: 2, second: 2,
    },
    kg: 'kg',
    beats: 'bpm',
    pressureOver: 'over',
    distance: [['km|k|kilomet(?:er|re)s?', 1], ['mi|miles?', KM_IN_MILE]],
    goals: {
      kcal: 'kcal|calories|cal',
      protein: 'proteins?',
      fat: 'fats?',
      carbs: 'carbs?|carbohydrates',
      fiber: 'fiber|fibre',
      water: 'water',
      sugar: 'sugar',
      salt: 'salt',
      sleep: 'sleep',
      weight: 'weight',
      steps: 'steps',
      day: 'day',
      budget: 'budget',
    },
  },
};

type Groups = (string | undefined)[];

// Граница слова: `\b` в регулярных выражениях JS не знает кириллицы, а просмотр назад есть не во всех
// браузерах — поэтому символ перед словом захватывается первой группой и в совпадение не входит.
// Класс букв и цифр общий для всех языков словаря
function word(body: string) {
  return new RegExp(`(^|[^${ALNUM}])(${body})(?![${ALNUM}])`, 'g');
}

function bodies(entries: Entry<unknown>[]) {
  return entries.map(([body]) => body).join('|');
}

function lookup<T>(entries: Entry<T>[]) {
  const compiled = entries.map(([body, value]) => [new RegExp(`^(?:${body})$`), value] as const);
  return (text: string) => compiled.find(([re]) => re.test(text))?.[1];
}

// Словарь, собранный в выражения: считается один раз на язык
function compile(words: QuickWords) {
  const weekday = bodies(words.weekdays);
  const month = bodies(words.months);
  const small = Object.keys(words.numbers).join('|');
  const ordinal = words.ordinal ? `(?:${words.ordinal})?` : '';
  const of = words.of ? `(?:(?:${words.of})\\s+)?` : '';
  // «через 3 дня», «in 2 weeks»: единицы — день, неделя, месяц
  const inBody = (open: string) => (
    `(?:${words.in})\\s+(?:${open}\\d+|${small})\\s+)${words.isInCountRequired ? '' : '?'}${open}${
      bodies(words.units.slice(0, 3))})`
  );
  const date = [
    bodies(words.relative),
    inBody('(?:'),
    words.nextWeek,
    '\\d{1,2}\\.\\d{2}(?:\\.\\d{4}|\\.\\d{2})?',
    `\\d{1,2}${ordinal}\\s+${of}(?:${month})`,
    ...(words.isMonthFirst ? [`(?:${month})\\s+\\d{1,2}${ordinal}`] : []),
    `(?:(?:${words.weekdayLead})\\s+)?(?:${weekday})`,
  ].join('|');
  const listSeparator = `(?:\\s*,\\s*(?:(?:${words.and})\\s+)?|\\s+(?:${words.and})\\s+)`;
  const lead = (body: string) => new RegExp(`^\\s*(?:${body})${SEPARATOR}\\s*`);
  const whole = (body: string) => new RegExp(`^(?:${body})$`);
  return {
    words,
    weekday,
    month,
    date,
    listSeparator,
    count: `\\d{1,2}|${small}`,
    daypart: bodies(words.dayparts),
    // Единица минут после числа
    minutes: `(?:\\s*(?:${words.minute})${words.minuteGlued ? `|(?:${words.minuteGlued})` : ''})`,
    kindLead: new RegExp(`^\\s*(?:(${words.task})|(${words.event}))(?:\\s*[:—–]\\s*|\\s+-\\s+|\\s+|$)`),
    waterLead: lead(words.water),
    typoWords: words.typoWords.split(' '),
    typoSafe: new Set([...words.typoWords.split(' '), ...(words.typoSafe || '').split(' ')]),
    sleepLead: lead(`(?:(?:${words.sleepPrefix || '(?!)'})\\s+)*(?:${words.sleep})`),
    plainSleepLead: lead(words.sleep),
    bedWake: words.sleepBed && words.sleepWake ? new RegExp(
      `(?:^|[^${ALNUM}])(?:${words.sleepBed})\\s+(?:(?:${words.at})\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?`
      + `[^${ALNUM}]+(?:(?:${words.and})\\s+)?(?:${words.sleepWake})\\s+(?:(?:${words.at})\\s+)?`
      + `(\\d{1,2})(?:[:.](\\d{2}))?${SEPARATOR}`,
    ) : undefined,
    workoutLead: lead(words.workout),
    goalLead: lead(words.goal),
    metricLead: new RegExp(`^\\s*(${bodies(words.metrics)})${SEPARATOR}\\s*(.*)$`),
    weakLead: words.weakLeads ? lead(words.weakLeads) : undefined,
    listSplit: new RegExp(listSeparator),
    isEvery: whole(words.every),
    isWeakWeekday: words.weakWeekdays ? whole(words.weakWeekdays) : undefined,
    isPluralWeekday: words.pluralWeekday ? new RegExp(`(?:${words.pluralWeekday})$`) : undefined,
    isBareDaypart: words.bareDayparts ? whole(words.bareDayparts) : undefined,
    isNextWeek: whole(words.nextWeek),
    inParts: whole(inBody('(')),
    dayMonth: new RegExp(`^(\\d{1,2})${ordinal}\\s+${of}(${month})$`),
    monthDay: new RegExp(`^(${month})\\s+(\\d{1,2})`),
    weekdayParts: new RegExp(`^(?:(?:${words.weekdayLead})\\s+)?(${weekday})$`),
    weekdayOf: lookup(words.weekdays),
    monthOf: lookup(words.months),
    daypartOf: lookup(words.dayparts),
    relativeOf: lookup(words.relative),
    unitOf: lookup(words.units),
    adverbOf: lookup(words.adverbs),
    spanOf: lookup(words.spans),
    mealOf: lookup(words.meals),
    metricOf: lookup(words.metrics),
    distanceOf: lookup(words.distance),
    namedTimeOf: lookup(words.namedTimes || []),
    countOf: (text?: string) => (text ? (words.numbers[text] ?? Number(text)) : 1),
  };
}

type Lang = ReturnType<typeof compile>;

const LANGS: Record<QuickLang, Lang> = { ru: compile(WORDS.ru), en: compile(WORDS.en) };

// Язык словаря по коду языка интерфейса
export function getQuickLang(code?: string): QuickLang {
  return code?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function toNumber(value: string) {
  return Number(value.replace(',', '.'));
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
  const delta = (weekday - fromDayKey(from).getDay() + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  return addDays(from, delta || (isTodayCounted ? 0 : DAYS_IN_WEEK));
}

// День недели, если текст — название дня (с предлогом либо без)
function weekdayIn(text: string, lang: Lang) {
  const parts = lang.weekdayParts.exec(text);
  return parts ? lang.weekdayOf(parts[1]) : undefined;
}

function resolveDate(text: string, today: string, lang: Lang): string | undefined {
  const relative = lang.relativeOf(text);
  if (relative !== undefined) return addDays(today, relative);
  const inParts = lang.inParts.exec(text);
  if (inParts) {
    const count = lang.countOf(inParts[1]);
    const unit = lang.unitOf(inParts[2]);
    return unit === 'monthly' ? addMonths(today, count)
      : addDays(today, unit === 'weekly' ? count * DAYS_IN_WEEK : count);
  }
  if (lang.isNextWeek.test(text)) return nextWeekday(today, 1, false);
  const dotted = /^(\d{1,2})\.(\d{2})(?:\.(\d{2,4}))?$/.exec(text);
  if (dotted) {
    return nearestDate(today, Number(dotted[2]), Number(dotted[1]), dotted[3] ? Number(dotted[3]) : undefined);
  }
  const dayMonth = lang.dayMonth.exec(text);
  if (dayMonth) return nearestDate(today, lang.monthOf(dayMonth[2]) || 0, Number(dayMonth[1]));
  const monthDay = lang.words.isMonthFirst ? lang.monthDay.exec(text) : undefined;
  if (monthDay) return nearestDate(today, lang.monthOf(monthDay[1]) || 0, Number(monthDay[2]));
  const weekday = weekdayIn(text, lang);
  if (weekday !== undefined) return nextWeekday(today, weekday, false);
  // «до марта»: первый день месяца
  const month = lang.monthOf(text);
  return month ? nearestDate(today, month, 1) : undefined;
}

function resolveHour(hour: number, minute: number, daypart?: Daypart) {
  if (hour > 24 || minute > 59 || (hour === 24 && minute)) return undefined;
  let h = hour;
  if (daypart === 'pm') {
    if (h < 12) h += 12;
  } else if (daypart === 'night') {
    if (h === 12) h = 0;
    else if (h >= 9 && h < 12) h += 12;
  } else if (daypart === 'am') {
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

// Язык разбора. Строка без букв либо с буквами одного языка словаря разбирается этим языком (без букв —
// языком интерфейса): русская строка понятна и при английском интерфейсе, и наоборот. Строка со смешанными
// буквами («зал присед 4x8x80», «созвон Zoom завтра») разбирается обоими словарями по отдельности, берётся
// разбор, распознавший больше; при равенстве — язык интерфейса. Слова двух словарей в одной строке не
// складываются
export function parseQuickInput(text: string, ctx: QuickContext): QuickDraft {
  const lang = ctx.lang || 'ru';
  const other: QuickLang = lang === 'ru' ? 'en' : 'ru';
  const has: Record<QuickLang, boolean> = { ru: /[а-яё]/i.test(text), en: /[a-z]/i.test(text) };
  if (!has[other]) return parseLine(text, ctx, LANGS[lang]);
  if (!has[lang]) return parseLine(text, ctx, LANGS[other]);
  const own = parseLine(text, ctx, LANGS[lang]);
  const foreign = parseLine(text, ctx, LANGS[other]);
  return recognisedCount(foreign) > recognisedCount(own) ? foreign : own;
}

// «по понидельникам каждую ниделю»: длинное слово с одной опечаткой (замена, пропуск, лишняя буква,
// перестановка соседних) читается как слово разбора. Первая буква обязана совпасть
function fixTypos(text: string, lang: Lang) {
  return text.replace(/[a-zа-яё]+/gi, (token) => {
    const typed = token.toLowerCase().replace(/ё/g, 'е');
    if (typed.length < MIN_TYPO_LENGTH || lang.typoSafe.has(typed)) return token;
    return lang.typoWords.find((known) => known[0] === typed[0] && isOneEditAway(typed, known)) || token;
  });
}

function isOneEditAway(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  const restA = a.slice(start);
  const restB = b.slice(start);
  if (a.length === b.length) {
    return restA.slice(1) === restB.slice(1)
      || (restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2));
  }
  return a.length > b.length ? restA.slice(1) === restB : restA === restB.slice(1);
}

// Сколько распознано: помеченные участки; запись здоровья, еды или воды без ошибки — ещё одно
function recognisedCount(draft: QuickDraft) {
  const isPlain = draft.kind === 'task' || draft.kind === 'event';
  return draft.spans.length + (!isPlain && !draft.error ? 1 : 0);
}

function parseLine(typed: string, ctx: QuickContext, lang: Lang): QuickDraft {
  const { words } = lang;
  const text = fixTypos(typed, lang);
  const folded = text.toLowerCase().replace(/ё/g, 'е');
  // Свёртка регистра обязана сохранять позиции символов: участки меряются по исходной строке
  const lower = folded.length === text.length ? folded : text;
  const taken = new Array<boolean>(text.length).fill(false);
  const spans: QuickSpan[] = [];
  const skipped = new Set(ctx.skip);
  const allowed = new Set<QuickKind>(ctx.kind ? [ctx.kind] : (ctx.kinds || ALL_KINDS));

  // Здоровье и цели узнаются по первому слову; тип, выбранный пользователем, сильнее слова
  const health = parseHealth(text, lower, ctx, allowed, lang);
  if (health) return health;

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
    const lead = lang.kindLead.exec(lower);
    const leadKind: QuickKind | undefined = lead ? (lead[2] ? 'event' : 'task') : undefined;
    if (lead && leadKind && allowed.has(leadKind) && !skipped.has('kind')) {
      explicitKind = leadKind;
      mark('kind', 0, lead[0].length);
    }
  }

  // ── числа с единицами: питание и вода ─────────────────────────────────────
  const nutrients: Partial<Record<QuickNutrient, number>> = {};
  if (allowed.has('food') && explicitKind !== 'water') {
    scan('kcal', `(${NUM})\\s*(?:${words.kcal})`, (g) => {
      nutrients.kcal = toNumber(g[1]!);
    });
    const macroBody = (names: string) => `(?:${names})\\s*(${NUM})(?:\\s*(?:${words.gram}))?`;
    const scanMacro = ([names, nutrient]: Entry<QuickNutrient>) => {
      scan(nutrient, macroBody(names), (g) => {
        nutrients[nutrient] = toNumber(g[1]!);
      });
    };
    words.macros.forEach(scanMacro);
    // «f1», «c4» — обычные слова: одна буква с числом считается, когда признаков питания не меньше двух
    const short = (words.shortMacros || []).filter(([names]) => word(macroBody(names)).test(lower));
    if (Object.keys(nutrients).length + short.length > 1) short.forEach(scanMacro);
  }
  const isFood = explicitKind === 'food' || (!explicitKind && Object.keys(nutrients).length > 0);
  if (isFood) {
    scan('grams', `(${NUM})\\s*(?:${words.gram})`, (g) => {
      draft.grams = toNumber(g[1]!);
    });
    scan('meal', bodies(words.meals), (g) => {
      draft.meal = lang.mealOf(g[0]!);
    });
  }

  let isWater = false;
  if (!isFood && allowed.has('water') && (!explicitKind || explicitKind === 'water')) {
    const lead = lang.waterLead.exec(lower);
    const volume = `(${NUM})\\s*(?:(${words.ml})|(${words.glass})|(${words.litre}))`;
    const found = word(volume).exec(lower);
    const rest = found ? lower.slice(lead?.[0].length || 0).replace(found[2], '').trim() : 'x';
    // Вода — слово «вода» в начале либо один объём без других слов
    if (found && (lead || explicitKind === 'water' || !rest)) {
      scan('water', volume, (g) => {
        draft.waterMl = Math.round(toNumber(g[1]!) * (g[2] ? 1 : g[3] ? GLASS_ML : ML_IN_LITRE));
      });
      if (lead) mark('kind', 0, lead[0].length);
      isWater = draft.waterMl !== undefined;
    }
    if (explicitKind === 'water') isWater = true;
  }

  // ── длительность ──────────────────────────────────────────────────────────
  if (!isFood && !isWater) {
    scan('minutes', `(${words.hourAndHalf})|(?:${words.halfHour})`, (g) => {
      draft.minutes = g[1] ? 90 : 30;
    });
    if (draft.minutes === undefined) {
      scan('minutes', `(${NUM})\\s*(?:${words.hour})(?:\\s*(\\d{1,2})${lang.minutes})?`, (g) => {
        draft.minutes = Math.round(toNumber(g[1]!) * MINUTES_IN_HOUR) + Number(g[2] || 0);
      });
    }
    if (draft.minutes === undefined) {
      scan('minutes', `(\\d{1,4})${lang.minutes}`, (g) => {
        draft.minutes = Number(g[1]);
      });
    }
  }

  // ── время: диапазон, затем одно значение ──────────────────────────────────
  let start: number | undefined;
  let end: number | undefined;
  if (!isWater) {
    const clock = `(${HOUR})(?::(${MINUTE}))?(?:\\s*(${lang.daypart}))?`;
    scan('time', `(?:(${words.from})\\s+)?${clock}\\s*(?:${DASH}|${words.to})\\s*${clock}`, (g) => {
      const fromPart = g[4] ? lang.daypartOf(g[4]) : undefined;
      const toPart = g[7] ? lang.daypartOf(g[7]) : undefined;
      // «10-12» без «с», без минут и без уточнения — не время (счёт, номер, диапазон чего угодно)
      if (!g[1] && g[3] === undefined && g[6] === undefined && !fromPart && !toPart) return false;
      let from = resolveHour(Number(g[2]), Number(g[3] || 0), fromPart);
      const to = resolveHour(Number(g[5]), Number(g[6] || 0), toPart);
      if (from === undefined || to === undefined) return false;
      // «5-6pm»: уточнение конца относится и к началу, если начало при этом остаётся раньше конца
      if (!fromPart && toPart) {
        const same = resolveHour(Number(g[2]), Number(g[3] || 0), toPart);
        if (same !== undefined && same < to) from = same;
      }
      start = from;
      end = to;
      return true;
    });
    if (start === undefined) {
      scan('time', `(?:(?:${words.at})\\s+)?(${HOUR}):(${MINUTE})(?:\\s*(${lang.daypart}))?`, (g) => {
        start = resolveHour(Number(g[1]), Number(g[2]), g[3] ? lang.daypartOf(g[3]) : undefined);
        return start !== undefined;
      });
    }
    if (start === undefined) {
      scan('time', `(?:(${words.at})\\s+)?(${HOUR})(?![.:,]\\d)(?:\\s*(${lang.daypart}))?`, (g) => {
        // Голый час — только с предлогом («в 5») либо с уточнением, понятным без него («5pm»)
        if (!g[1] && !(g[3] && lang.isBareDaypart?.test(g[3]))) return false;
        const part = g[3] ? lang.daypartOf(g[3]) : undefined;
        start = part ? resolveHour(Number(g[2]), 0, part) : resolveBareHour(Number(g[2]), ctx);
        return start !== undefined;
      });
    }
    if (start === undefined && words.namedTimes) {
      scan('time', `(?:(?:${words.at})\\s+)?(${bodies(words.namedTimes)})`, (g) => {
        start = lang.namedTimeOf(g[1]!);
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
    const units = bodies(words.units);
    scan('repeat', `(?:${words.every})\\s+(?:(${lang.count})\\s+)?(${units})`, (g) => {
      repeatKind = lang.unitOf(g[2]!);
      interval = lang.countOf(g[1]);
    });
    if (!repeatKind) {
      scan('repeat', bodies(words.adverbs), (g) => {
        repeatKind = lang.adverbOf(g[0]!);
      });
    }
    if (!repeatKind) {
      scan('repeat', `(?:${words.oncePer})\\s+(?:(${lang.count})\\s+)?(${units})`, (g) => {
        repeatKind = lang.unitOf(g[2]!);
        interval = lang.countOf(g[1]);
      });
    }
    const pickDays = (days: number[]) => {
      if (repeatKind && repeatKind !== 'weekly') return false;
      repeatKind = 'weekly';
      weekdays = days;
      return true;
    };
    if (!weekdays) scan('repeat', words.workdays, () => pickDays([1, 2, 3, 4, 5]));
    if (!weekdays) scan('repeat', words.weekends, () => pickDays([6, 0]));
    if (!weekdays) {
      const list = `(?:${lang.weekday})(?:${lang.listSeparator}(?:${lang.weekday}))*`;
      scan('repeat', `(?:(${words.every}|${words.on})\\s+)?(${list})`, (g) => {
        const names = g[2]!.split(lang.listSplit);
        const isRepeat = g[1]
          // «каждый вторник», «по вт»; «on friday» — дата, «on mon and wed» — повтор
          ? lang.isEvery.test(g[1]) || words.isOnAlwaysRepeat || names.length > 1
          : false;
        // «mondays 19:00» — повтор и без предлога
        const isPlural = names.some((name) => lang.isPluralWeekday?.test(name));
        if (!isRepeat && !isPlural) return false;
        return pickDays([...new Set(names.map((name) => lang.weekdayOf(name)!))]);
      });
    }
    if (repeatKind) {
      scan('repeat', `(?:${words.until})\\s+(${lang.date}|${lang.month})`, (g) => {
        endDay = resolveDate(g[1]!, ctx.today, lang);
        return Boolean(endDay);
      });
      scan('repeat', `(\\d{1,3})\\s*(?:${words.times})`, (g) => {
        count = Number(g[1]);
      });
      const spanLead = words.spanLead ? `(?:(?:${words.spanLead})\\s+)?` : '';
      scan('repeat', `${spanLead}(\\d{1,2})\\s*(${bodies(words.spans)})`, (g) => {
        const amount = Number(g[1]);
        const unit = lang.spanOf(g[2]!);
        if (unit === 'month') spanMonths = amount;
        else if (unit === 'week') spanWeeks = amount;
        else spanMonths = amount * 12;
      });
    }
  }

  // ── срок и дата ───────────────────────────────────────────────────────────
  let day: string | undefined;
  let namedWeekday: number | undefined;
  if (!isWater) {
    if (!isFood) {
      scan('due', `(?:${words.until})\\s+(${lang.date}|${lang.month})`, (g) => {
        draft.due = resolveDate(g[1]!, ctx.today, lang);
        return Boolean(draft.due);
      });
    }
    scan('day', `(?:(?:${words.dayLead})\\s+)?(${lang.date})`, (g, from, to) => {
      const value = g[1]!;
      const weekday = weekdayIn(value, lang);
      if (weekday !== undefined) {
        // «1000 Вт» — не вторник: день недели сразу после числа, не распознанного как значение, — не день
        const before = lower.slice(0, from).trimEnd().length - 1;
        if (before >= 0 && /\d/.test(lower[before]) && !taken[before]) return false;
        // «sat down» — не суббота: такое сокращение без предлога — день только в конце строки, перед
        // числом или перед уже распознанным значением
        if (g[0] === value && lang.isWeakWeekday?.test(value)) {
          const after = to + lower.slice(to).search(/\S/);
          if (after >= to && !taken[after] && !/[\d,;.!?)]/.test(lower[after])) return false;
        }
      }
      day = resolveDate(value, ctx.today, lang);
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
    if (start !== undefined && start < MINUTES_IN_DAY) draft.start = toTime(start);
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
    if (!endDay && spanWeeks) endDay = addDays(startDay, spanWeeks * DAYS_IN_WEEK);
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

// ── здоровье и цели (spec 020) ───────────────────────────────────────────────

function parseHealth(
  text: string, lower: string, ctx: QuickContext, allowed: Set<QuickKind>, lang: Lang,
): QuickDraft | undefined {
  const can = (kind: QuickKind) => allowed.has(kind) && (!ctx.kind || ctx.kind === kind);
  // Слово, обычное и в названиях дел: без разобранного значения это не запись здоровья
  const isWeak = !ctx.kind && Boolean(lang.weakLead?.test(lower));
  const settle = (draft?: QuickDraft) => (isWeak && draft?.error ? undefined : draft);
  if (!ctx.skip?.includes('kind')) {
    if (can('goal') && lang.goalLead.test(lower)) {
      const goal = parseGoal(lower.replace(lang.goalLead, ''), ctx, lang);
      // Найденная, но неверная цель — ошибка цели, а не название дела
      return isWeak && goal.error === 'name' ? undefined : goal;
    }
    const metric = can('metric') && lang.metricLead.exec(lower);
    if (metric) return settle(parseMetric(lang.metricOf(metric[1])!, metric[2], ctx, lang));
    if (can('sleep') && lang.sleepLead.test(lower)) {
      const sleep = parseSleep(lower.replace(lang.sleepLead, ''), ctx, lang);
      // «я спал плохо» без времени — не запись сна, а обычная строка
      return !lang.plainSleepLead.test(lower) && sleep.error ? undefined : settle(sleep);
    }
    const bedWake = can('sleep') && lang.bedWake?.exec(lower);
    if (bedWake) return sleepRange(bedWake, ctx);
  }
  if (ctx.kind === 'sleep') return parseSleep(lower, ctx, lang);
  // Тип «цель» выбран вызывающим: слово «цель» в начале не обязательно
  if (ctx.kind === 'goal') return parseGoal(lower, ctx, lang);
  if (can('workout') && (ctx.kind === 'workout' || lang.workoutLead.test(lower))) {
    return settle(parseWorkout(text, lower, ctx, lang));
  }
  return undefined;
}

function healthDraft(kind: QuickKind, ctx: QuickContext, patch: Partial<QuickDraft>): QuickDraft {
  return {
    kind, name: '', day: ctx.today, spans: [], ...patch,
  };
}

function parseMetric(metric: QuickMetric, rest: string, ctx: QuickContext, { words }: Lang): QuickDraft {
  const fail = healthDraft('metric', ctx, { metric, error: 'name' });
  if (metric === 'pressure') {
    const pair = new RegExp(`^(\\d{2,3})\\s*(?:\\/|${words.pressureOver})\\s*(\\d{2,3})$`).exec(rest.trim());
    return pair ? healthDraft('metric', ctx, { metric, value: Number(pair[1]), value2: Number(pair[2]) }) : fail;
  }
  const number = new RegExp(`^(\\d[\\d ]*(?:[.,]\\d+)?)\\s*(?:${words.kg}|${words.beats})?$`).exec(rest.trim());
  if (!number) return fail;
  const value = toNumber(number[1].replace(/ /g, ''));
  const isWhole = Number.isInteger(value);
  const isValid = metric === 'weight' ? value > 0 && value < 500
    : metric === 'mood' ? isWhole && value >= 1 && value <= MAX_MOOD
      : metric === 'steps' ? isWhole && value <= MAX_STEPS : isWhole && value > 0 && value < 300;
  return isValid ? healthDraft('metric', ctx, { metric, value }) : fail;
}

// «23:40-07:30» — лёг и встал (ночь уходит за полночь); «7,5 ч», «7 ч 30 мин» — только длительность
function parseSleep(rest: string, ctx: QuickContext, lang: Lang): QuickDraft {
  const { words } = lang;
  // Минуты необязательны: «с 4 до 12»; «7-8 ч» — не время, а длительность
  const range = new RegExp(
    `(\\d{1,2})(?:[:.](\\d{2}))?\\s*(?:${DASH}|${words.to})\\s*(\\d{1,2})(?:[:.](\\d{2}))?`
    + `(?![.,:]?\\d|\\s*(?:${words.hour})${SEPARATOR})`,
  ).exec(rest);
  if (range) return sleepRange(range, ctx);
  const duration = new RegExp(
    `(${NUM})\\s*(?:${words.hour})${SEPARATOR}(?:\\s*(\\d{1,2})${lang.minutes}${SEPARATOR})?`,
  ).exec(rest);
  const minutes = duration ? Math.round(toNumber(duration[1]) * MINUTES_IN_HOUR) + Number(duration[2] || 0) : 0;
  return minutes > 0 && minutes < MINUTES_IN_DAY
    ? healthDraft('sleep', ctx, { minutes }) : healthDraft('sleep', ctx, { error: 'time' });
}

// Группы: час и минуты отхода ко сну, час и минуты подъёма
function sleepRange(groups: RegExpExecArray, ctx: QuickContext): QuickDraft {
  const typedBed = resolveHour(Number(groups[1]), Number(groups[2] || 0));
  const wake = resolveHour(Number(groups[3]), Number(groups[4] || 0));
  // «с 11 до 7» — лёг вечером: сон дольше 16 часов означает, что час отхода назван без «вечера»
  const isEvening = typedBed !== undefined && wake !== undefined && typedBed < MINUTES_IN_DAY / 2
    && (wake - typedBed + MINUTES_IN_DAY) % MINUTES_IN_DAY > MAX_SLEEP_MINUTES;
  const bed = isEvening ? typedBed + MINUTES_IN_DAY / 2 : typedBed;
  if (bed === undefined || wake === undefined || bed === wake || bed >= MINUTES_IN_DAY || wake >= MINUTES_IN_DAY) {
    return healthDraft('sleep', ctx, { error: 'time' });
  }
  return healthDraft('sleep', ctx, {
    start: toTime(bed), end: toTime(wake), minutes: (wake - bed + MINUTES_IN_DAY) % MINUTES_IN_DAY,
  });
}

// Тренировка-запись: «бег 5 км 28 мин», «зал присед 4x8x80, жим 3x10x60», «зал 60 мин». Тренировка с
// временем начала, на будущий день либо с повтором — запланированное событие календаря, его разбирает
// основной разбор
function parseWorkout(text: string, lower: string, ctx: QuickContext, lang: Lang): QuickDraft | undefined {
  const { words } = lang;
  const taken = new Array<boolean>(text.length).fill(false);
  const cut = (from: number, to: number) => {
    for (let i = from; i < to; i++) taken[i] = true;
  };
  let distanceKm: number | undefined;
  const distance = new RegExp(`(${NUM})\\s*(${bodies(words.distance)})${SEPARATOR}`).exec(lower);
  if (distance) {
    distanceKm = Math.round(toNumber(distance[1]) * (lang.distanceOf(distance[2]) || 1) * 100) / 100;
    cut(distance.index, distance.index + distance[0].length);
  }
  const exercises: PlannerExercise[] = [];
  // Название, затем «подходы × повторы × вес» (вес необязателен); упражнения разделены запятой
  const sets = new RegExp(
    `([${LETTER}][${LETTER} ]*?)\\s*(\\d{1,2})\\s*[xх×*]\\s*(\\d{1,3})`
    + `(?:\\s*[xх×*]\\s*(\\d+(?:[.,]\\d+)?))?\\s*(?:${words.kg})?\\s*(?:,|;|$)`,
    'g',
  );
  const lead = lang.workoutLead.exec(lower);
  sets.lastIndex = lead ? lead[0].length : 0;
  let match = sets.exec(lower);
  while (match) {
    exercises.push({
      name: text.slice(match.index, match.index + match[1].length).trim(),
      sets: Number(match[2]),
      reps: Number(match[3]),
      weight: match[4] ? toNumber(match[4]) : undefined,
    });
    cut(match.index, match.index + match[0].length);
    match = sets.exec(lower);
  }
  const rest = [...text].map((char, i) => (taken[i] ? ' ' : char)).join('');
  const base = parseLine(rest, { ...ctx, kind: 'event', kinds: undefined }, lang);
  const isRecord = Boolean(distanceKm || exercises.length)
    || (!base.start && !base.repeat && (base.day || ctx.today) <= ctx.today);
  if (!isRecord && ctx.kind !== 'workout') return undefined;
  const hasContent = Boolean(distanceKm || exercises.length || base.minutes);
  return {
    kind: 'workout',
    name: base.name,
    day: base.day || ctx.today,
    start: base.start,
    minutes: base.minutes,
    distanceKm,
    exercises: exercises.length ? exercises : undefined,
    spans: [],
    error: !base.name ? 'name' : !hasContent ? 'minutes' : undefined,
  };
}

// «цель белок 140 вода 2,5л сон 8ч день с 8 до 22» — меняет цели и настройки
function parseGoal(rest: string, ctx: QuickContext, { words }: Lang): QuickDraft {
  const names = words.goals;
  const changes: QuickGoalChanges = { goals: {}, health: {} };
  let found = 0;
  const take = (body: string, apply: (groups: Groups) => void) => {
    const match = word(body).exec(rest);
    if (!match) return;
    apply(match.slice(2));
    found += 1;
  };
  const goal = (metric: Exclude<PlannerGoalMetric, 'water'>) => {
    take(`(?:${names[metric]})\\s*(${NUM})`, (g) => {
      changes.goals[metric] = toNumber(g[1]!);
    });
  };
  goal('kcal');
  goal('protein');
  goal('fat');
  goal('carbs');
  goal('fiber');
  take(`(?:${names.water})\\s*(${NUM})\\s*(?:(${words.ml})|(${words.litre}))?`, (g) => {
    const amount = toNumber(g[1]!);
    // Без единицы: большое число — миллилитры, малое — литры
    changes.goals.water = Math.round(g[2] || (!g[3] && amount > 20) ? amount : amount * ML_IN_LITRE);
  });
  take(`(?:${names.sugar})\\s*(${NUM})`, (g) => {
    changes.health.sugarMax = toNumber(g[1]!);
  });
  take(`(?:${names.salt})\\s*(${NUM})`, (g) => {
    changes.health.saltMax = toNumber(g[1]!);
  });
  take(`(?:${names.sleep})\\s*(${NUM})\\s*(?:${words.hour})?`, (g) => {
    changes.health.sleepMinutes = Math.round(toNumber(g[1]!) * MINUTES_IN_HOUR);
  });
  take(`(?:${names.weight})\\s*(${NUM})`, (g) => {
    changes.health.weight = toNumber(g[1]!);
  });
  take(`(?:${names.steps})\\s*(\\d[\\d ]*\\d|\\d)`, (g) => {
    changes.health.steps = Number(g[1]!.replace(/ /g, ''));
  });
  take(
    `(?:${names.day})\\s+(?:(?:${words.from})\\s+)?(${HOUR})(?::(${MINUTE}))?\\s*(?:${DASH}|${words.to})\\s*`
    + `(${HOUR})(?::(${MINUTE}))?`,
    (g) => {
      changes.dayStart = Number(g[1]) * MINUTES_IN_HOUR + Number(g[2] || 0);
      changes.dayEnd = Number(g[3]) * MINUTES_IN_HOUR + Number(g[4] || 0);
    },
  );
  take(`(?:${names.budget})\\s*(${NUM})\\s*(?:${words.hour})?`, (g) => {
    changes.budget = Math.round(toNumber(g[1]!) * MINUTES_IN_HOUR);
  });
  const isWindowValid = changes.dayStart === undefined || changes.dayEnd === undefined
    || changes.dayStart < changes.dayEnd;
  return healthDraft('goal', ctx, {
    day: undefined, goalChanges: changes, error: !found ? 'name' : !isWindowValid ? 'time' : undefined,
  });
}
