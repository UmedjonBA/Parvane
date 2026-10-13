// Ввод текстом (spec 017): одна строка → черновик записи «Плана». Чистая функция без сети. Шаги:
//   1. опечатки (`fixTypos`) и числительные словами (`plannerNumerals.ts`);
//   2. распознаватели предлагают кандидатов — участок строки, поле, значение, оценка;
//   3. лучший набор кандидатов без пересечений (`plannerQuickPick.ts`), остальные чтения — варианты;
//   4. тип записи, название и описание — из того, что никто не забрал.
// Слова разбора лежат в словаре на язык (`WORDS`); распознаватели, их ранги и правила неоднозначности —
// общие для всех языков. «Сейчас» и «сегодня» приходят только из `ctx`.

import type {
  PlannerEventError, PlannerExercise, PlannerGoalMetric, PlannerHealthGoals, PlannerHealthKind, PlannerMeal,
  PlannerNutrient, PlannerRepeat, PlannerRepeatKind, PlannerTaskError,
} from './plannerModel';
import type { NumeralEdit } from './plannerNumerals';
import type { PickItem } from './plannerQuickPick';

import { maskNameLinks, unmaskNameLinks } from './plannerLinks';
import {
  addDays, DEFAULT_EVENT_MINUTES, fromDayKey, MINUTES_IN_DAY, toDayKey, toTime, validateEvent,
  validateRepeat, validateTask,
} from './plannerModel';
import { restoreNumerals, rewriteNumerals, toSourceOffset } from './plannerNumerals';
import { candidateScore, pickCandidates } from './plannerQuickPick';

// sleep, workout, metric — записи здоровья (spec 020); goal — правка целей и настроек, записи не создаёт
export type QuickKind = 'task' | 'event' | 'food' | 'water' | 'sleep' | 'workout' | 'metric' | 'goal';
export type QuickNutrient = PlannerNutrient | 'sugar' | 'salt';
export type QuickField =
  'kind' | 'day' | 'time' | 'minutes' | 'due' | 'repeat' | 'meal' | 'grams' | 'water' | 'health' | 'description'
  | 'list' | 'place' | 'important' | QuickNutrient;
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
// Другие чтения строки: значение поля, на которое пользователь может переключиться. `pick` — ключ
// значения: время `HH:MM` либо `HH:MM-HH:MM`, день и срок `YYYY-MM-DD`, тип записи, для повтора —
// `QUICK_REPEAT_OPEN` («до <дата>» не конец ряда, слова остаются в названии) либо `QUICK_REPEAT_END`
// (обратно; `day` — конец ряда)
export type QuickAltField = 'kind' | 'time' | 'day' | 'due' | 'repeat';
export type QuickAlt = { field: QuickAltField; pick: string; day?: string };
// Чтение, закреплённое пользователем; тип закрепляется выбором типа (`ctx.kind`)
export type QuickPick = Partial<Record<Exclude<QuickAltField, 'kind'>, string>>;
// Выученное по правкам пользователя (`plannerQuickLearn.ts`): первое слово названия → значения по умолчанию
export type QuickLearnedKind = 'task' | 'event';
export type QuickLearned = Record<string, { kind?: QuickLearnedKind; minutes?: number }>;
export type QuickSpan = { field: QuickField; from: number; to: number };
export type QuickError = PlannerTaskError | PlannerEventError;

export type QuickDraft = {
  kind: QuickKind;
  name: string;
  // Описание задачи либо события: часть строки после названия (правила — у `splitName`)
  description?: string;
  // Явные метки строки задачи либо события: `#список` (только у задачи), `@место` (первая строка
  // описания записи — `quickDescription`), `!` — важное (только у задачи: статус «В работе»)
  list?: string;
  place?: string;
  isImportant?: boolean;
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
  // Задача и событие. Первое слово названия (нижний регистр, «ё» → «е», без служебных и однобуквенных
  // слов) — ключ личного словаря правок
  head?: string;
  // Событие со временем: обычная длительность для этого слова без словаря правок
  usualMinutes?: number;
  // Что подставлено из словаря правок (`ctx.learned`)
  learned?: ('kind' | 'minutes')[];
  // Другие чтения распознанных значений (не больше `MAX_ALTERNATIVES` на поле)
  alternatives?: QuickAlt[];
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
  // Значения по умолчанию из личного словаря правок; явное значение в строке и выбор пользователя сильнее.
  // Снятые `kind` и `minutes` (`skip`) выключают и выученное
  learned?: QuickLearned;
  // Чтения, выбранные пользователем из других вариантов (`QuickDraft.alternatives`); ключ, которому в
  // строке ничего не отвечает, не действует
  pick?: QuickPick;
  // Язык интерфейса (по умолчанию русский). Строка на другом языке словаря тоже разбирается — правило
  // выбора у `parseQuickInput`
  lang?: QuickLang;
};

export const QUICK_TASK_MINUTES = 30;
export const QUICK_REPEAT_OPEN = 'open';
export const QUICK_REPEAT_END = 'end';
const MAX_ALTERNATIVES = 4;
const MAX_PICK_ROUNDS = 8;
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
const MARKER_FIELDS: QuickField[] = ['list', 'place', 'important'];

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
  // Обычная длительность события по первому слову названия, минуты («пара» — 1 ч 45 мин, «урок» — 45 мин)
  eventMinutes?: Entry<number>[];
  // Слова-меры: в конце названия значат длительность, а не название («… пн 18:30 пара»). Только те, что
  // в конце названия обычно не стоят: «урок» и «встреча» сюда не входят («английский урок»)
  eventMinutesTail?: Entry<number>[];
  // Название и описание (правила — у `splitName`).
  // Слова, с которых начинается описание; само слово остаётся в описании («будет тест», «взять паспорт»)
  descLeads: string;
  // Метки вместе со своим знаком: [метка, остаётся ли она в описании].
  // false — только подпись, отбрасывается («описание: …», «прим. …»); true — несёт смысл («тема: оптика»)
  descLabels: Entry<boolean>[];
  // Служебные слова (местоимения, предлоги, союзы, частицы): название не может ни начинаться, ни кончаться
  // таким словом — «мне надо купить молоко» и «в банке взять справку» остаются названием целиком
  descWeak: string;
  // Сокращения с точкой, после которых предложение не кончается («ул. Ленина»); одна буква — тоже сокращение
  abbreviations: string;
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
  // Уточнение перед временем: «вечером в 7», «tomorrow morning at 7». Без часа такое слово — не время
  daypartLeads?: Entry<Daypart>[];
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
    eventMinutes: [['пар[ауые]', 105], ['урок(?:а|и|ов)?', 45], ['созвон(?:а|ы|ов)?', 30], ['встреч[аиу]', 60]],
    eventMinutesTail: [['пара', 105]],
    descLeads: 'будет|будут|нужно|надо|не\\s+забыть|взять|принести',
    descLabels: [['(?:описание|примечание|заметка|прим)\\s*:|прим\\.', false], ['тема\\s*:', true]],
    descWeak: 'я|мне|мы|нам|ты|тебе|вы|вам|он|ему|она|ей|они|им|это|что|чтобы|если|когда|как|где|и|или|а|но|не'
      + '|еще|уже|тоже|там|тут|в|во|на|у|из|для|к|ко|от|по|с|со|за|до|при|о|об|под|над|через|после|перед|без',
    abbreviations: 'ул|пр|пер|пл|кв|корп|стр|оф|ауд|каб|эт|им|см|напр|др|руб|тыс|млн|мин|сек|тел|доб|кг|гр|мл|шт|уп'
      + '|экз|км|мм',
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
    dayparts: [['утра|утром', 'am'], ['дня|днем|вечера|вечером', 'pm'], ['ночи|ночью', 'night']],
    daypartLeads: [['утром', 'am'], ['днем|вечером', 'pm'], ['ночью', 'night']],
    namedTimes: [['полдень', 12 * MINUTES_IN_HOUR], ['полночь', 0]],
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
    eventMinutes: [['lessons?', 45], ['calls?', 30], ['meetings?', 60], ['stand-?ups?', 15]],
    descLeads: 'will\\s+be|need\\s+to|needs|don[\'’]?t\\s+forget|bring',
    descLabels: [['(?:notes?|description)\\s*:', false], ['topic\\s*:', true]],
    descWeak: 'i|me|we|us|you|he|him|she|her|they|them|it|this|that|there|what|who|if|when|and|or|but|not|to|also'
      + '|just|still|at|in|on|from|for|after|before|with|without|of|by|the|a|an',
    abbreviations: 'etc|vs|mr|mrs|ms|dr|st|no|approx|apt|rm|tel|ext|min|max|hr|hrs|kg|ml|pcs|km|lb|lbs|oz',
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
      ['am|a\\.m\\.|in\\s+the\\s+morning|this\\s+morning', 'am'],
      ['pm|p\\.m\\.|in\\s+the\\s+(?:afternoon|evening)|this\\s+(?:afternoon|evening)|tonight', 'pm'],
      ['at\\s+night', 'night'],
    ],
    daypartLeads: [['(?:this\\s+)?morning', 'am'], ['(?:this\\s+)?(?:afternoon|evening)|tonight', 'pm']],
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

// ── кандидаты ────────────────────────────────────────────────────────────────
// Распознаватель предлагает кандидата: участок строки, поле (чип) и значение. Слот — значение, которое
// в записи одно; оценка и выбор набора — `plannerQuickPick.ts`. Ранг распознавателя — насколько он точен:
// метки и единицы питания старше длительности, длительность — времени, время — повтора, срок — дня;
// внутри поля составное старше простого.
const RANK = {
  kind: 60,
  // Метки: список, место, «важное» — по убыванию
  marker: 58,
  kcal: 54,
  // Нутриенты по порядку словаря — по убыванию
  macro: 52,
  shortMacro: 44,
  grams: 40,
  meal: 39,
  waterLead: 38,
  water: 37,
  durationHalf: 34,
  durationHours: 33,
  durationMinutes: 32,
  timeRange: 30,
  timeClock: 29,
  timeHour: 28,
  timeNamed: 27,
  repeatEvery: 24,
  repeatAdverb: 23,
  repeatOnce: 22,
  repeatWorkdays: 21,
  repeatWeekends: 20,
  repeatDays: 19,
  repeatEnd: 18,
  repeatCount: 17,
  repeatSpan: 16,
  due: 12,
  day: 10,
};

type CandidateValue = {
  nutrient?: QuickNutrient;
  isShort?: boolean;
  amount?: number;
  meal?: PlannerMeal;
  minutes?: number;
  // Время в минутах от полуночи; `altStart` — другое чтение часа («в 7»: утро либо вечер)
  start?: number;
  end?: number;
  altStart?: number;
  repeatKind?: PlannerRepeatKind;
  interval?: number;
  days?: number[];
  count?: number;
  months?: number;
  weeks?: number;
  // День либо срок; `altDay` — другое чтение (сегодня, а не через неделю; этот год, а не следующий)
  day?: string;
  altDay?: string;
  weekday?: number;
  isWeak?: boolean;
};
type Candidate = PickItem & {
  slot: string;
  field: QuickField;
  value: CandidateValue;
  // Условие: кандидат годится только при таком выборе кандидатов старше его
  when?: (state: Chosen, item: Candidate) => boolean;
};
// Выбранный набор и то, что о нём спрашивают условия
type Chosen = {
  items: Candidate[];
  slots: Map<string, Candidate>;
  // Занятые символы строки; день в счёт не идёт — он младше всех
  taken: boolean[];
  nutrients: number;
  regularNutrients: number;
};

function chosenState(items: Candidate[], length: number): Chosen {
  const taken = new Array<boolean>(length).fill(false);
  const slots = new Map<string, Candidate>();
  let nutrients = 0;
  let regularNutrients = 0;
  items.forEach((item) => {
    slots.set(item.slot, item);
    if (item.slot !== 'day') taken.fill(true, item.from, item.to);
    if (item.value.nutrient) nutrients += 1;
    if (item.value.nutrient && !item.value.isShort) regularNutrients += 1;
  });
  return {
    items, slots, taken, nutrients, regularNutrients,
  };
}

function matchZones(re: RegExp, lower: string) {
  const zones: { from: number; to: number; groups: Groups }[] = [];
  for (let found = re.exec(lower); found; found = re.exec(lower)) {
    const from = found.index + found[1].length;
    zones.push({ from, to: from + found[2].length, groups: found.slice(2) });
    re.lastIndex = Math.max(from + found[2].length, found.index + 1);
  }
  return zones;
}

// Ключ значения для вариантов и закрепления: время, день, срок
const PICK_SLOTS = ['time', 'day', 'due'] as const;
type PickSlot = typeof PICK_SLOTS[number];

function timeKey(start?: number, end?: number) {
  if (start === undefined || start >= MINUTES_IN_DAY) return undefined;
  if (end === undefined || end > MINUTES_IN_DAY) return toTime(start);
  return `${toTime(start)}-${toTime(Math.min(end, MINUTES_IN_DAY - 1))}`;
}

function valueKey(slot: PickSlot, value: CandidateValue) {
  return slot === 'time' ? timeKey(value.start, value.end) : value.day;
}

function altKey(slot: PickSlot, value: CandidateValue) {
  return slot === 'time' ? timeKey(value.altStart, value.end) : value.altDay;
}

// Закреплённое чтение: в слоте остаётся кандидат с этим значением (своим либо другим чтением)
function pinCandidates(pool: Candidate[], pick?: QuickPick) {
  if (!pick) return pool;
  let result = pool;
  PICK_SLOTS.forEach((slot) => {
    const wanted = pick[slot];
    if (!wanted) return;
    const inSlot = result.filter((item) => item.slot === slot);
    const exact = inSlot.find((item) => valueKey(slot, item.value) === wanted);
    const other = exact ? undefined : inSlot.find((item) => altKey(slot, item.value) === wanted);
    const pinned: Candidate | undefined = exact || (other && {
      ...other,
      value: slot === 'time' ? { ...other.value, start: other.value.altStart, altStart: other.value.start }
        : { ...other.value, day: other.value.altDay, altDay: other.value.day },
    });
    if (pinned) result = [...result.filter((item) => item.slot !== slot), pinned];
  });
  return result;
}

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
function compile(id: QuickLang, words: QuickWords) {
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
    id,
    words,
    weekday,
    month,
    date,
    listSeparator,
    count: `\\d{1,2}|${small}`,
    daypart: bodies(words.dayparts),
    // Уточнение перед временем; пустой словарь — выражение, которое не совпадает ни с чем
    daypartLead: `(?:(${bodies(words.daypartLeads || []) || '(?!)'})\\s+)?`,
    // Единица минут после числа
    minutes: `(?:\\s*(?:${words.minute})${words.minuteGlued ? `|(?:${words.minuteGlued})` : ''})`,
    kindLead: new RegExp(`^\\s*(?:(${words.task})|(${words.event}))(?:\\s*[:—–]\\s*|\\s+-\\s+|\\s+|$)`),
    waterLead: lead(words.water),
    eventMinutes: (words.eventMinutes || []).map(([body, minutes]) => (
      // Ссылки на заметки перед словом (их заглушки) первым словом не считаются: «[[Сервер]] созвон 16:00»
      [new RegExp(`^\\s*(?:[\\ue000-\\uf8ff]+\\s*)*(?:${body})${SEPARATOR}`), minutes] as const
    )),
    // То же слово в КОНЦЕ названия («ОГЭ по информатике пн 18:30 пара») — мера длительности, не часть названия
    eventMinutesTail: (words.eventMinutesTail || []).map(([body, minutes]) => (
      [new RegExp(`^(?:(.*[^${ALNUM}]))?(?:${body})\\s*$`), minutes] as const
    )),
    descLeads: words.descLeads,
    // Название начинается служебным словом либо словом-вводом описания или кончается служебным словом
    isWeakName: new RegExp(
      `^(?:${words.descWeak}|${words.descLeads})${SEPARATOR}|(?:^|[^${ALNUM}])(?:${words.descWeak})$`,
    ),
    // Метка со знаком в конце названия: группа 1 — метка-подпись, группа 2 — метка, несущая смысл
    labelTail: new RegExp(
      `(?:^|[^${ALNUM}])(?:(${bodies(words.descLabels.filter(([, isKept]) => !isKept))})`
      + `|(${bodies(words.descLabels.filter(([, isKept]) => isKept))}))$`,
    ),
    labelHead: new RegExp(`^(?:${bodies(words.descLabels.filter(([, isKept]) => !isKept))})\\s*(?=\\S)`),
    abbreviationTail: new RegExp(`(?:^|[^${ALNUM}])(?:${words.abbreviations}|[${LETTER}])$`),
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
    isFunctionWord: whole(words.descWeak),
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
    daypartLeadOf: lookup(words.daypartLeads || []),
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

// Словарь языка компилируется при первом разборе, а не при загрузке модуля (десятки регулярных выражений)
const LANGS: Partial<Record<QuickLang, Lang>> = {};

function langOf(id: QuickLang): Lang {
  let lang = LANGS[id];
  if (!lang) {
    lang = compile(id, WORDS[id]);
    LANGS[id] = lang;
  }
  return lang;
}

// Язык словаря по коду языка интерфейса
export function getQuickLang(code?: string): QuickLang {
  return code?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Обычная длительность события по первому слову названия: её разбор подставит сам, когда она не названа. */
export function quickUsualMinutes(name: string, lang: QuickLang) {
  const head = maskNameLinks(name).text.toLowerCase().replace(/ё/g, 'е');
  return langOf(lang).eventMinutes.find(([pattern]) => pattern.test(head))?.[1] || DEFAULT_EVENT_MINUTES;
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

// Ближайшая будущая дата с таким числом и месяцем (сегодня считается); `isNear` — дата этого года,
// даже если она уже прошла
function nearestDate(today: string, month: number, dayOfMonth: number, year?: number, isNear = false) {
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return undefined;
  const build = (y: number) => {
    const date = new Date(y, month - 1, dayOfMonth);
    return date.getMonth() === month - 1 ? toDayKey(date) : undefined;
  };
  if (year !== undefined) return build(year < 100 ? 2000 + year : year);
  const thisYear = fromDayKey(today).getFullYear();
  const day = build(thisYear);
  return day && (isNear || day >= today) ? day : build(thisYear + 1);
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

// `isNear` — другое чтение: день недели, совпавший с сегодняшним, — сегодня (а не через неделю), дата без
// года — в этом году, даже если прошла
function resolveDate(text: string, today: string, lang: Lang, isNear = false): string | undefined {
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
    return nearestDate(
      today, Number(dotted[2]), Number(dotted[1]), dotted[3] ? Number(dotted[3]) : undefined, isNear,
    );
  }
  const dayMonth = lang.dayMonth.exec(text);
  if (dayMonth) return nearestDate(today, lang.monthOf(dayMonth[2]) || 0, Number(dayMonth[1]), undefined, isNear);
  const monthDay = lang.words.isMonthFirst ? lang.monthDay.exec(text) : undefined;
  if (monthDay) return nearestDate(today, lang.monthOf(monthDay[1]) || 0, Number(monthDay[2]), undefined, isNear);
  const weekday = weekdayIn(text, lang);
  if (weekday !== undefined) return nextWeekday(today, weekday, isNear);
  // «до марта»: первый день месяца
  const month = lang.monthOf(text);
  return month ? nearestDate(today, month, 1, undefined, isNear) : undefined;
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

// Разговорные часы («полтретьего», «quarter to five») двенадцатичасовые: половина суток — по окну дня,
// как у голого часа
function resolveLooseClock(hour: number, minute: number, ctx: QuickContext) {
  const morning = (hour % 12) * MINUTES_IN_HOUR + minute;
  const evening = morning + 12 * MINUTES_IN_HOUR;
  const isInside = (value: number) => value >= ctx.dayStart && value <= ctx.dayEnd;
  return !isInside(morning) && isInside(evening) ? evening : morning;
}

function fold(text: string) {
  const folded = text.toLowerCase().replace(/ё/g, 'е');
  // Свёртка регистра обязана сохранять позиции символов: участки меряются по исходной строке
  return folded.length === text.length ? folded : text;
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
//
// Ссылки на заметки `[[…]]` разбор не читает: на время разбора они закрыты заглушками (`maskNameLinks`) и
// целиком остаются в названии либо описании — «[[Встреча завтра]] сб 15:00» ставится на субботу
export function parseQuickInput(typed: string, ctx: QuickContext): QuickDraft {
  const { text, links } = maskNameLinks(typed);
  const draft = parseMasked(text, ctx);
  if (!links.length) return draft;
  draft.name = unmaskNameLinks(draft.name, links);
  if (draft.description) draft.description = unmaskNameLinks(draft.description, links);
  return draft;
}

function parseMasked(text: string, ctx: QuickContext): QuickDraft {
  const lang = ctx.lang || 'ru';
  const other: QuickLang = lang === 'ru' ? 'en' : 'ru';
  const has: Record<QuickLang, boolean> = { ru: /[а-яё]/i.test(text), en: /[a-z]/i.test(text) };
  if (!has[other]) return parseLine(text, ctx, langOf(lang));
  if (!has[lang]) return parseLine(text, ctx, langOf(other));
  const own = parseLine(text, ctx, langOf(lang));
  const foreign = parseLine(text, ctx, langOf(other));
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

// Строка проходит правку опечаток и замену числительных цифрами (`plannerNumerals.ts`), затем разбор
function parseLine(typed: string, ctx: QuickContext, lang: Lang): QuickDraft {
  const { text, edits } = rewriteNumerals(fixTypos(typed, lang), lang.id);
  return parseText(text, edits, ctx, lang);
}

// `text` — строка с цифрами на месте числительных, `edits` — её замены: название и описание режутся из
// слов пользователя (незабранная замена возвращает исходные слова), участки — в позициях этих слов
function parseText(text: string, edits: NumeralEdit[], ctx: QuickContext, lang: Lang): QuickDraft {
  const { words } = lang;
  const lower = fold(text);
  const taken = new Array<boolean>(text.length).fill(false);
  const spans: QuickSpan[] = [];
  const skipped = new Set(ctx.skip);
  const allowed = new Set<QuickKind>(ctx.kind ? [ctx.kind] : (ctx.kinds || ALL_KINDS));

  // Здоровье и цели узнаются по первому слову; тип, выбранный пользователем, сильнее слова
  const health = parseHealth(text, lower, edits, ctx, allowed, lang);
  if (health) return health;

  const draft: QuickDraft = { kind: 'task', name: '', spans };
  let explicitKind = ctx.kind;

  // ── кандидаты ──────────────────────────────────────────────────────────────
  // Каждый распознаватель предлагает все свои совпадения, не глядя на остальные; условие `when` —
  // зависимость от уже выбранного («граммы — только у еды», «до <дата>» — конец ряда, только если есть
  // повтор). Лучший набор без пересечений выбирает `pickCandidates` (`plannerQuickPick.ts`)
  const pool: Candidate[] = [];
  const push = (
    slot: string, field: QuickField, rank: number, from: number, to: number, value: CandidateValue = {},
    when?: Candidate['when'],
  ) => {
    pool.push({
      slot, field, from, to, score: candidateScore(rank, from, to), value, when,
    });
  };
  // Все совпадения выражения по порядку; `read` возвращает значение либо ничего — «не моё»
  const offer = (
    slot: string, field: QuickField, rank: number, body: string,
    read: (groups: Groups, from: number, to: number) => CandidateValue | undefined,
    when?: Candidate['when'],
  ) => {
    if (skipped.has(field)) return;
    const re = word(body);
    for (let match = re.exec(lower); match; match = re.exec(lower)) {
      const from = match.index + match[1].length;
      const to = from + match[2].length;
      re.lastIndex = Math.max(to, match.index + 1);
      const value = read(match.slice(2), from, to);
      if (value) push(slot, field, rank, from, to, value, when);
    }
  };

  // Слова-типы в начале строки
  if (!explicitKind) {
    const lead = lang.kindLead.exec(lower);
    const leadKind: QuickKind | undefined = lead ? (lead[2] ? 'event' : 'task') : undefined;
    if (lead && leadKind && allowed.has(leadKind) && !skipped.has('kind')) {
      explicitKind = leadKind;
      push('kind', 'kind', RANK.kind, 0, lead[0].length);
    }
  }

  // Явные метки: #список, @место, !. Старше всех, чтобы слова внутри метки не разбирались («#пт» —
  // список, а не пятница); у записи, которой метка не положена, участок возвращается в название
  MARKERS.forEach(([field, find], index) => {
    const found = skipped.has(field) ? undefined : find(text);
    if (found) push(field, field, RANK.marker - index, found.from, found.to);
  });

  // Числа с единицами: питание и вода
  const isFoodIn = (state: Chosen) => explicitKind === 'food' || (!explicitKind && state.nutrients > 0);
  const isWaterIn = (state: Chosen) => explicitKind === 'water' || state.slots.has('water');
  if (allowed.has('food') && explicitKind !== 'water') {
    offer('kcal', 'kcal', RANK.kcal, `(${NUM})\\s*(?:${words.kcal})`, (g) => (
      { nutrient: 'kcal', amount: toNumber(g[1]!) }
    ));
    const macroBody = (names: string) => `(?:${names})\\s*(${NUM})(?:\\s*(?:${words.gram}))?`;
    words.macros.forEach(([names, nutrient], index) => {
      offer(nutrient, nutrient, RANK.macro - index, macroBody(names), (g) => ({ nutrient, amount: toNumber(g[1]!) }));
    });
    // «f1», «c4» — обычные слова: одна буква с числом считается, когда признаков питания не меньше двух
    const short = (words.shortMacros || []).filter(([names]) => word(macroBody(names)).test(lower));
    short.forEach(([names, nutrient], index) => {
      offer(`short-${nutrient}`, nutrient, RANK.shortMacro - index, macroBody(names), (g) => (
        { nutrient, amount: toNumber(g[1]!), isShort: true }
      ), (state) => state.regularNutrients + short.length > 1);
    });
  }
  offer('grams', 'grams', RANK.grams, `(${NUM})\\s*(?:${words.gram})`, (g) => ({ amount: toNumber(g[1]!) }), isFoodIn);
  offer('meal', 'meal', RANK.meal, bodies(words.meals), (g) => ({ meal: lang.mealOf(g[0]!) }), isFoodIn);

  if (allowed.has('water') && (!explicitKind || explicitKind === 'water')) {
    const lead = lang.waterLead.exec(lower);
    const volume = `(${NUM})\\s*(?:(${words.ml})|(${words.glass})|(${words.litre}))`;
    const found = word(volume).exec(lower);
    const rest = found ? lower.slice(lead?.[0].length || 0).replace(found[2], '').trim() : 'x';
    // Вода — слово «вода» в начале либо один объём без других слов
    if (found && (lead || explicitKind === 'water' || !rest)) {
      const isNotFood = (state: Chosen) => !isFoodIn(state);
      offer('water', 'water', RANK.water, volume, (g) => (
        { amount: Math.round(toNumber(g[1]!) * (g[2] ? 1 : g[3] ? GLASS_ML : ML_IN_LITRE)) }
      ), isNotFood);
      if (lead) push('waterLead', 'kind', RANK.waterLead, 0, lead[0].length, {}, isNotFood);
    }
  }

  // Длительность: составная старше простой
  const isPlainIn = (state: Chosen) => !isFoodIn(state) && !isWaterIn(state);
  offer('minutes', 'minutes', RANK.durationHalf, `(${words.hourAndHalf})|(?:${words.halfHour})`, (g) => (
    { minutes: g[1] ? 90 : 30 }
  ), isPlainIn);
  const hoursBody = `(${NUM})\\s*(?:${words.hour})(?:\\s*(\\d{1,2})${lang.minutes})?`;
  offer('minutes', 'minutes', RANK.durationHours, hoursBody, (g) => (
    { minutes: Math.round(toNumber(g[1]!) * MINUTES_IN_HOUR) + Number(g[2] || 0) }
  ), isPlainIn);
  offer('minutes', 'minutes', RANK.durationMinutes, `(\\d{1,4})${lang.minutes}`, (g) => (
    { minutes: Number(g[1]) }
  ), isPlainIn);

  // Время: диапазон старше одного значения, часы с минутами — голого часа
  const isNotWaterIn = (state: Chosen) => !isWaterIn(state);
  const clock = `(${HOUR})(?::(${MINUTE}))?(?:\\s*(${lang.daypart}))?`;
  const repeatZones = matchZones(
    word(`(?:${words.every}|${words.oncePer})\\s+(?:${lang.count})\\s+(?:${bodies(words.units)})`), lower,
  );
  // Уточнение после часа сильнее уточнения перед ним: «вечером в 7», «в 7 вечера»
  const daypartIn = (after?: string, before?: string) => (
    after ? lang.daypartOf(after) : before ? lang.daypartLeadOf(before) : undefined
  );
  const rangeBody = `(?:(${words.from})\\s+)?${clock}\\s*(?:${DASH}|${words.to})\\s*${clock}`;
  offer('time', 'time', RANK.timeRange, rangeBody, (g) => {
    const fromPart = g[4] ? lang.daypartOf(g[4]) : undefined;
    const toPart = g[7] ? lang.daypartOf(g[7]) : undefined;
    // «10-12» без «с», без минут и без уточнения — не время (счёт, номер, диапазон чего угодно)
    if (!g[1] && g[3] === undefined && g[6] === undefined && !fromPart && !toPart) return undefined;
    let from = resolveHour(Number(g[2]), Number(g[3] || 0), fromPart);
    const to = resolveHour(Number(g[5]), Number(g[6] || 0), toPart);
    if (from === undefined || to === undefined) return undefined;
    // «5-6pm»: уточнение конца относится и к началу, если начало при этом остаётся раньше конца
    if (!fromPart && toPart) {
      const same = resolveHour(Number(g[2]), Number(g[3] || 0), toPart);
      if (same !== undefined && same < to) from = same;
    }
    return { start: from, end: to };
  }, isNotWaterIn);
  const clockBody = `${lang.daypartLead}(?:(?:${words.at})\\s+)?(${HOUR}):(${MINUTE})(?:\\s*(${lang.daypart}))?`;
  offer('time', 'time', RANK.timeClock, clockBody, (g, from, to) => {
    const part = daypartIn(g[4], g[1]);
    const hour = Number(g[2]);
    const minute = Number(g[3]);
    // Разговорные часы двенадцатичасовые: вторая половина суток — другое чтение
    if (!part && edits.some((edit) => edit.isLoose && edit.from >= from && edit.to <= to)) {
      const start = resolveLooseClock(hour, minute, ctx);
      return { start, altStart: (start + MINUTES_IN_DAY / 2) % MINUTES_IN_DAY };
    }
    const start = resolveHour(hour, minute, part);
    return start === undefined ? undefined : { start };
  }, isNotWaterIn);
  const hourBody = `${lang.daypartLead}(?:(${words.at})\\s+)?(${HOUR})(?![.:,]\\d)(?:\\s*(${lang.daypart}))?`;
  offer('time', 'time', RANK.timeHour, hourBody, (g, from, to) => {
    // Голый час — только с предлогом («в 5») либо с уточнением, понятным без него («5pm»)
    if (!g[2] && !(g[4] && lang.isBareDaypart?.test(g[4]))) return undefined;
    // «раз в 2 недели», «once in 2 weeks»: число принадлежит повтору
    if (repeatZones.some((zone) => zone.from < to && from < zone.to)) return undefined;
    const part = daypartIn(g[4], g[1]);
    const hour = Number(g[3]);
    if (part) {
      const start = resolveHour(hour, 0, part);
      return start === undefined ? undefined : { start };
    }
    // «в 7» — утро либо вечер: выбор по окну дня, другое чтение остаётся вариантом
    const start = resolveBareHour(hour, ctx);
    const isAmbiguous = hour >= 1 && hour < 12;
    return { start, altStart: isAmbiguous ? (start + MINUTES_IN_DAY / 2) % MINUTES_IN_DAY : undefined };
  }, isNotWaterIn);
  if (words.namedTimes) {
    offer('time', 'time', RANK.timeNamed, `(?:(?:${words.at})\\s+)?(${bodies(words.namedTimes)})`, (g) => {
      const start = lang.namedTimeOf(g[1]!);
      return start === undefined ? undefined : { start };
    }, isNotWaterIn);
  }

  // Повтор
  const units = bodies(words.units);
  const repeatKindIn = (state: Chosen) => (
    state.slots.get('repeatKind')?.value.repeatKind || (state.slots.has('weekdays') ? 'weekly' as const : undefined)
  );
  const hasRepeatIn = (state: Chosen) => isPlainIn(state) && Boolean(repeatKindIn(state));
  // Дни недели — только у еженедельного повтора
  const isWeeklyIn = (state: Chosen) => {
    const kind = state.slots.get('repeatKind')?.value.repeatKind;
    return isPlainIn(state) && (!kind || kind === 'weekly');
  };
  offer('repeatKind', 'repeat', RANK.repeatEvery, `(?:${words.every})\\s+(?:(${lang.count})\\s+)?(${units})`, (g) => (
    { repeatKind: lang.unitOf(g[2]!), interval: lang.countOf(g[1]) }
  ), isPlainIn);
  offer('repeatKind', 'repeat', RANK.repeatAdverb, bodies(words.adverbs), (g) => (
    { repeatKind: lang.adverbOf(g[0]!) }
  ), isPlainIn);
  offer('repeatKind', 'repeat', RANK.repeatOnce, `(?:${words.oncePer})\\s+(?:(${lang.count})\\s+)?(${units})`, (g) => (
    { repeatKind: lang.unitOf(g[2]!), interval: lang.countOf(g[1]) }
  ), isPlainIn);
  offer('weekdays', 'repeat', RANK.repeatWorkdays, words.workdays, () => ({ days: [1, 2, 3, 4, 5] }), isWeeklyIn);
  offer('weekdays', 'repeat', RANK.repeatWeekends, words.weekends, () => ({ days: [6, 0] }), isWeeklyIn);
  const dayList = `(?:${lang.weekday})(?:${lang.listSeparator}(?:${lang.weekday}))*`;
  offer('weekdays', 'repeat', RANK.repeatDays, `(?:(${words.every}|${words.on})\\s+)?(${dayList})`, (g) => {
    const names = g[2]!.split(lang.listSplit);
    const isRepeat = g[1]
      // «каждый вторник», «по вт»; «on friday» — дата, «on mon and wed» — повтор
      ? lang.isEvery.test(g[1]) || words.isOnAlwaysRepeat || names.length > 1
      : false;
    // «mondays 19:00» — повтор и без предлога
    const isPlural = names.some((name) => lang.isPluralWeekday?.test(name));
    if (!isRepeat && !isPlural) return undefined;
    return { days: [...new Set(names.map((name) => lang.weekdayOf(name)!))] };
  }, isWeeklyIn);
  // «N мес / N раз / до <дата>» — граница ряда, только когда повтор найден; иначе «до <дата>» — срок
  const untilBody = `(?:${words.until})\\s+(${lang.date}|${lang.month})`;
  const readDate = (value: string): CandidateValue | undefined => {
    const day = resolveDate(value, ctx.today, lang);
    if (!day) return undefined;
    // Другое чтение: день недели — сегодня, а не через неделю; дата без года — в этом году, хотя прошла
    const altDay = resolveDate(value, ctx.today, lang, true);
    return { day, altDay: altDay !== day ? altDay : undefined };
  };
  if (ctx.pick?.repeat !== QUICK_REPEAT_OPEN) {
    offer('repeatEnd', 'repeat', RANK.repeatEnd, untilBody, (g) => readDate(g[1]!), hasRepeatIn);
  }
  offer('repeatCount', 'repeat', RANK.repeatCount, `(\\d{1,3})\\s*(?:${words.times})`, (g) => (
    { count: Number(g[1]) }
  ), hasRepeatIn);
  const spanLead = words.spanLead ? `(?:(?:${words.spanLead})\\s+)?` : '';
  offer('repeatSpan', 'repeat', RANK.repeatSpan, `${spanLead}(\\d{1,2})\\s*(${bodies(words.spans)})`, (g) => {
    const amount = Number(g[1]);
    const unit = lang.spanOf(g[2]!);
    return unit === 'week' ? { weeks: amount } : { months: unit === 'month' ? amount : amount * 12 };
  }, hasRepeatIn);

  // Срок и дата: «до пт» как срок старше «пт» как дня
  offer('due', 'due', RANK.due, untilBody, (g) => readDate(g[1]!), isPlainIn);
  offer('day', 'day', RANK.day, `(?:(?:${words.dayLead})\\s+)?(${lang.date})`, (g) => {
    const value = readDate(g[1]!);
    if (!value) return undefined;
    const weekday = weekdayIn(g[1]!, lang);
    if (weekday === undefined) return value;
    // «sat down» — не суббота: такое сокращение без предлога — день только в конце строки, перед
    // числом или перед уже распознанным значением
    return { ...value, weekday, isWeak: g[0] === g[1] && Boolean(lang.isWeakWeekday?.test(g[1]!)) };
  }, (state, { value, from, to }) => {
    if (isWaterIn(state)) return false;
    if (value.weekday === undefined) return true;
    // «1000 Вт» — не вторник: день недели сразу после числа, не распознанного как значение, — не день
    const before = lower.slice(0, from).trimEnd().length - 1;
    if (before >= 0 && /\d/.test(lower[before]) && !state.taken[before]) return false;
    if (value.isWeak) {
      const after = to + lower.slice(to).search(/\S/);
      if (after >= to && !state.taken[after] && !/[\d,;.!?)]/.test(lower[after])) return false;
    }
    return true;
  });

  // «до <дата>» при повторе прочитано не как конец ряда (выбор пользователя): слова остаются в названии —
  // ни срок, ни день их не забирают
  const openZones = ctx.pick?.repeat === QUICK_REPEAT_OPEN ? matchZones(word(untilBody), lower) : [];
  const offered = !openZones.length ? pool : pool.map((item): Candidate => {
    const isInside = (item.slot === 'due' || item.slot === 'day')
      && openZones.some((zone) => zone.from < item.to && item.from < zone.to);
    return !isInside ? item : {
      ...item, when: (state, self) => !repeatKindIn(state) && (!item.when || item.when(state, self)),
    };
  });
  const candidates = pinCandidates(offered, ctx.pick);

  // ── выбор ──────────────────────────────────────────────────────────────────
  // Условия зависят от выбранного, а выбранное — от условий: выбор повторяется, пока набор не
  // перестанет меняться. Условие кандидата смотрит только на кандидатов старше его рангом, поэтому
  // круг сходится за несколько шагов
  let state = chosenState([], text.length);
  for (let round = 0; round < MAX_PICK_ROUNDS; round++) {
    const current = state;
    const chosen = pickCandidates(candidates.filter((item) => !item.when || item.when(current, item)));
    state = chosenState(chosen, text.length);
    if (chosen.length === current.items.length && chosen.every((item, index) => item === current.items[index])) break;
  }
  const isFood = isFoodIn(state);
  const isWater = isWaterIn(state);
  let picked = state.items;
  const valueOf = (slot: string) => picked.find((item) => item.slot === slot)?.value;

  // ── значения выбранных кандидатов ──────────────────────────────────────────
  const nutrients: Partial<Record<QuickNutrient, number>> = {};
  // Однобуквенное обозначение разбирается после полного и потому сильнее его
  [false, true].forEach((isShort) => picked.forEach(({ value }) => {
    if (value.nutrient && Boolean(value.isShort) === isShort) nutrients[value.nutrient] = value.amount;
  }));
  draft.grams = valueOf('grams')?.amount;
  draft.meal = valueOf('meal')?.meal;
  draft.waterMl = valueOf('water')?.amount;
  draft.minutes = valueOf('minutes')?.minutes;
  const time = valueOf('time');
  const start = time?.start;
  const end = time?.end;
  const days = valueOf('weekdays')?.days;
  const repeatKind = repeatKindIn(state);
  const interval = valueOf('repeatKind')?.interval ?? 1;
  let weekdays = days;
  let endDay = valueOf('repeatEnd')?.day;
  const count = valueOf('repeatCount')?.count;
  const spanMonths = valueOf('repeatSpan')?.months || 0;
  const spanWeeks = valueOf('repeatSpan')?.weeks || 0;
  draft.due = valueOf('due')?.day;
  let day = valueOf('day')?.day;
  const namedWeekday = valueOf('day')?.weekday;

  const settle = () => {
    taken.fill(false);
    spans.length = 0;
    picked.forEach(({ field, from, to }) => {
      taken.fill(true, from, to);
      spans.push({ field, from, to });
    });
  };
  const unmark = (fields: QuickField[]) => {
    picked = picked.filter(({ field }) => !fields.includes(field));
    settle();
  };
  const markerText = (field: QuickField) => {
    const span = spans.find((item) => item.field === field);
    return span && text.slice(span.from + 1, span.to);
  };
  settle();

  // ── тип задачи либо события; метки, которые ему не положены ───────────────
  const blank = () => restoreNumerals(text.split('').map((char, i) => (taken[i] ? ' ' : char)).join(''), edits);
  const hasTime = start !== undefined;
  let learned: QuickLearned[string] | undefined;
  // Другие чтения: второе значение выбранного кандидата («в 7» — 07:00 либо 19:00) и кандидаты того же
  // поля, которым не хватило места в слоте («созвон 16:00 или 18:00»)
  const alternatives: QuickAlt[] = [];
  const suggest = (field: QuickAltField, pick?: string, altDay?: string) => {
    const isKnown = alternatives.some((item) => item.field === field && item.pick === pick);
    const isFull = alternatives.filter((item) => item.field === field).length >= MAX_ALTERNATIVES;
    if (pick && !isKnown && !isFull) alternatives.push(altDay ? { field, pick, day: altDay } : { field, pick });
  };
  PICK_SLOTS.forEach((slot) => {
    const winner = picked.find((item) => item.slot === slot);
    if (!winner) return;
    const current = valueKey(slot, winner.value);
    const other = altKey(slot, winner.value);
    if (other !== current) suggest(slot, other);
    // Закрепление оставляет в слоте одного кандидата — остальные берутся из полного набора. Из
    // пересекающихся остаётся лучший: диапазон, а не два его времени
    const spare = offered.filter((item) => (
      item.slot === slot && (!item.when || item.when(state, item))
      && !picked.some((taker) => taker.from < item.to && item.from < taker.to)
    ));
    pickCandidates(spare.map((item) => ({ ...item, slot: undefined }))).forEach((item) => {
      const key = valueKey(slot, item.value);
      if (key !== current) suggest(slot, key);
    });
  });
  // «до <дата>» при повторе — конец ряда; другое чтение — слова названия
  if (valueOf('repeatEnd')) {
    suggest('repeat', QUICK_REPEAT_OPEN);
  } else if (repeatKind && openZones.length) {
    const closed = openZones.map(({ groups }) => readDate(groups[1]!)?.day).find(Boolean);
    if (closed) suggest('repeat', QUICK_REPEAT_END, closed);
  }
  if (isWater || isFood) {
    unmark(MARKER_FIELDS);
  } else {
    // Первое слово названия считается до возврата меток: «#дом купить молоко» — «купить»
    draft.head = headWord(blank(), lang);
    learned = draft.head && ctx.learned && Object.prototype.hasOwnProperty.call(ctx.learned, draft.head)
      ? ctx.learned[draft.head] : undefined;
    const guessed: QuickKind = hasTime && allowed.has('event') ? 'event' : 'task';
    draft.kind = explicitKind === 'task' || explicitKind === 'event' ? explicitKind : guessed;
    if (!allowed.has(draft.kind)) draft.kind = allowed.has('task') ? 'task' : 'event';
    // Тип, выученный по правкам: когда пользователь не выбрал тип сам и не снял выученный
    if (!explicitKind && learned?.kind && learned.kind !== draft.kind && allowed.has(learned.kind)
      && !skipped.has('kind')) {
      draft.kind = learned.kind;
      draft.learned = ['kind'];
    }
    // У события нет ни списка, ни статуса: «#слово» и «!» остаются в названии
    if (draft.kind === 'event') unmark(['list', 'important']);
    // Событие либо задача: разбор выбрал сам — другое чтение остаётся вариантом (у задачи без даты и
    // времени его нет: событию нужен день)
    const otherKind: QuickKind = draft.kind === 'event' ? 'task' : 'event';
    const isDated = hasTime || Boolean(valueOf('day') || repeatKind);
    if (!explicitKind && allowed.has(otherKind) && (draft.kind === 'event' || isDated)) suggest('kind', otherKind);
    const list = markerText('list');
    draft.list = list && list.replace(/_/g, ' ');
    draft.place = markerText('place');
    draft.isImportant = spans.some(({ field }) => field === 'important') || undefined;
  }

  if (alternatives.length) draft.alternatives = alternatives;

  // ── название: всё непомеченное, в словах пользователя ─────────────────────
  const plain = blank();
  draft.name = cleanName(plain);
  spans.sort((a, b) => a.from - b.from);
  const mealSpan = spans.find(({ field }) => field === 'meal');
  const mealText = mealSpan ? text.slice(mealSpan.from, mealSpan.to) : '';
  if (edits.length) {
    spans.forEach((span) => {
      span.from = toSourceOffset(span.from, edits);
      span.to = toSourceOffset(span.to, edits, true);
    });
  }

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
    if (!draft.name) draft.name = mealText;
    if (!draft.name) draft.error = 'name';
    return draft;
  }

  // ── задача либо событие: название и описание ──────────────────────────────
  const split = skipped.has('description') ? undefined : splitName(plain, fold(plain), lang);
  if (split) {
    draft.name = split.name;
    draft.description = split.description;
    spans.push({
      field: 'description', from: split.from + plain.slice(split.from).search(/\S/), to: plain.trimEnd().length,
    });
    spans.sort((a, b) => a.from - b.from);
  }
  if (!day && (hasTime || draft.kind === 'event') && !repeatKind) {
    day = hasTime && start <= ctx.nowMinutes ? addDays(ctx.today, 1) : ctx.today;
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
      startDay = weekdays!.map((weekday) => nextWeekday(base, weekday, true)).sort()[0];
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
      // Обычная длительность — по первому слову НАЗВАНИЯ: «вт 15:00 пара по английскому» — пара,
      // «сдать пару отчётов 9:00» — нет
      const head = draft.name.toLowerCase().replace(/ё/g, 'е');
      let usual = lang.eventMinutes.find(([pattern]) => pattern.test(head))?.[1];
      if (!usual && end === undefined && !draft.minutes) {
        // Слово-мера в конце названия: длительность берётся по нему, а само слово из названия уходит
        const tail = lang.eventMinutesTail.find(([pattern]) => pattern.test(head));
        const rest = tail && draft.name.slice(0, (tail[0].exec(head)![1] || '').length).trim();
        if (tail && rest) {
          usual = tail[1];
          draft.name = rest;
        }
      }
      usual ||= DEFAULT_EVENT_MINUTES;
      // Длительность, выученная по правкам, — только когда она не названа и её чип не снят
      const isNamed = end !== undefined || Boolean(draft.minutes);
      const own = !isNamed && !skipped.has('minutes') && learned?.minutes !== usual ? learned?.minutes : undefined;
      if (own) draft.learned = [...(draft.learned || []), 'minutes'];
      draft.usualMinutes = usual;
      const finish = end ?? start + (draft.minutes || own || usual);
      draft.start = toTime(start);
      // Ровно полночь — последняя минута суток; позже — ошибка, а не обрезка
      draft.end = finish === MINUTES_IN_DAY ? '23:59' : finish < MINUTES_IN_DAY ? toTime(finish) : undefined;
      draft.minutes = end !== undefined ? end - start : draft.minutes;
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
    draft.start = toTime(start);
    draft.minutes = end !== undefined ? end - start : (draft.minutes ?? QUICK_TASK_MINUTES);
  }
  if (draft.repeat) draft.due = undefined;
  draft.error = validateTask({
    name: draft.name, minutes: draft.minutes, day: draft.day, start: draft.start, due: draft.due,
  }) || (draft.repeat && validateRepeat(draft.repeat));
  return draft;
}

// Первое слово названия для словаря правок: служебные и однобуквенные слова пропускаются
function headWord(name: string, lang: Lang) {
  const found = fold(name).match(new RegExp(`[${LETTER}]+`, 'g')) || [];
  return found.find((item) => item.length > 1 && !lang.isFunctionWord.test(item));
}

// ── явные метки ──────────────────────────────────────────────────────────────
// Метка — отдельное слово: перед знаком начало строки либо пробел, после слова — конец строки, пробел
// либо знак препинания. Поэтому не метки: «C#», «№5», адрес почты, ссылка с «#» либо «@» внутри.
//   #слово — список задачи: первая буква, дальше буквы, цифры, «_» (в названии списка — пробел) и «-».
//            «#1» (нумерация) — не список;
//   @место — место: буквы, цифры, «_» и «-», первый знак — буква либо цифра («@301ГК»);
//   !      — важное: один «!» отдельным словом либо один «!» в самом конце первой строки сразу после
//            слова («сдать отчёт!»). «!!!», «?!» и «!» в середине фразы («Ура! купить торт») — не метка.
// Берётся первая метка каждого вида; остальные остаются в названии.
type MarkerFinder = (text: string) => { from: number; to: number } | undefined;

const MARKER_TAIL = '(?![^\\s,;.:!?)])';

function markerFinder(pattern: string): MarkerFinder {
  const re = new RegExp(`(^|\\s)(${pattern})${MARKER_TAIL}`, 'u');
  return (text) => {
    const found = re.exec(text);
    if (!found) return undefined;
    const from = found.index + found[1].length;
    return { from, to: from + found[2].length };
  };
}

const findImportant: MarkerFinder = (text) => {
  const alone = /(^|\s)!(?=\s|$)/.exec(text);
  if (alone) {
    const from = alone.index + alone[1].length;
    return { from, to: from + 1 };
  }
  const lineEnd = text.indexOf('\n');
  const line = (lineEnd < 0 ? text : text.slice(0, lineEnd)).trimEnd();
  return /[^\s!?]!$/.test(line) ? { from: line.length - 1, to: line.length } : undefined;
};

const MARKERS: [QuickField, MarkerFinder][] = [
  ['list', markerFinder('#\\p{L}[\\p{L}\\p{N}_-]*')],
  ['place', markerFinder('@[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*')],
  ['important', findImportant],
];

/** Описание записи из черновика: место (`@…`) — первой строкой, за ним описание из строки. */
export function quickDescription(draft: Pick<QuickDraft, 'place' | 'description'>) {
  return [draft.place && `@${draft.place}`, draft.description].filter(Boolean).join('\n') || undefined;
}

// ── название и описание ──────────────────────────────────────────────────────

function cleanName(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;])/g, '$1')
    .replace(/^[\s,;.:—–-]+|[\s,;:—–-]+$/g, '');
}

// Описание многострочное: переводы строк внутри него сохраняются
function cleanDescription(text: string) {
  return text.split('\n').map(cleanName).filter(Boolean).join('\n');
}

// Ссылка на заметку (её заглушка) — тоже слово: название может состоять из неё одной
function hasLetter(text: string) {
  return new RegExp(`[${LETTER}ё\\ue000-\\uf8ff]`, 'i').test(text);
}

// Название и описание задачи либо события. На входе — строка, из которой уже вынуты распознанные
// значения (дата, время, длительность, срок, повтор заменены пробелами, позиции символов сохранены):
// значения могут стоять где угодно — перед названием, между названием и описанием, после описания.
//
// Название — короткая строка для календаря, описание — всё, что её поясняет. Граница ищется по
// признакам в порядке их силы; берётся первое место, слева от которого остаётся название (хотя бы одно
// слово с буквой), а справа — непустое описание:
//   1. перевод строки: первая строка — название, остальные — описание;
//   2. явный разделитель: тире либо дефис с пробелами по обе стороны (« — », « – », « - »), ` // `,
//      двоеточие, точка с запятой либо точка с пробелом после (`: `, `; `, `. `). Явный знак сильнее
//      слов: «Маме нужно позвонить — насчёт дачи» делится по тире, а не по слову «нужно».
//      Слово-метка со своим знаком (`descLabels`) — не название: подпись отбрасывается («встреча
//      описание: …», «встреча прим. …», «meeting note: …»), метка со смыслом уходит в описание вместе
//      со знаком («пара тема: оптика»). Без своего знака метки — обычные слова названия («написать
//      описание проекта», «новая тема оформления», «meeting notes - check the draft»);
//   3. слово-ввод описания (`descLeads`: «будет», «нужно», «надо», «не забыть», «взять», «принести»;
//      will be, need to, needs, don't forget, bring): описание начинается с него, слово в нём остаётся.
//      Срабатывает, только если после слова есть ещё слова, а название перед ним не начинается и не
//      кончается служебным словом (`descWeak`) и не начинается с другого слова-ввода: «надо взять
//      паспорт», «мне надо купить молоко», «в банке взять справку», «встреча не будет долгой» —
//      название целиком.
// Не делят: запятая («купить молоко, хлеб»), скобки («Рисование(ауд. 12)»), дефис и двоеточие без
// пробела («кое-что», «10:30», «a-b»), точка после сокращения либо одной буквы («ул. Ленина», «т.е.»),
// знаки внутри распознанных значений («10:00 — 11:30»), знак в самом начале либо конце строки.
// Снятое пользователем описание (`skip: ['description']`) возвращает слова в название.
function splitName(plain: string, lower: string, lang: Lang) {
  const result = (nameEnd: number, from: number) => {
    const name = cleanName(plain.slice(0, nameEnd)).replace(/\.+$/, '');
    const full = cleanDescription(plain.slice(from));
    // «встреча — описание: взять паспорт»: подпись в начале описания не нужна
    const description = full.slice(lang.labelHead.exec(full.toLowerCase())?.[0].length || 0);
    return hasLetter(name) && /[^\s\p{P}]/u.test(description) ? { name, description, from } : undefined;
  };

  const lineBreak = lower.indexOf('\n');
  const byLine = lineBreak >= 0 ? result(lineBreak, lineBreak + 1) : undefined;
  if (byLine) return byLine;

  const separator = /\s(?:[—–-]|\/\/)\s|[:;.]\s/g;
  let match = separator.exec(lower);
  while (match) {
    const sign = match[0].trim();
    const at = match.index + match[0].indexOf(sign);
    const to = at + sign.length;
    separator.lastIndex = match.index + 1;
    const label = lang.labelTail.exec(lower.slice(0, to));
    // Точка сразу после сокращения либо одной буквы предложение не кончает
    if (label || sign !== '.' || !lang.abbreviationTail.test(lower.slice(0, at))) {
      const labelAt = label ? to - (label[1] || label[2]).length : at;
      // «тема: оптика» уходит в описание целиком; подпись («описание:») отбрасывается
      const found = label?.[2] ? result(labelAt, labelAt) : result(labelAt, to);
      if (found) return found;
    }
    match = separator.exec(lower);
  }

  const lead = word(lang.descLeads);
  match = lead.exec(lower);
  while (match) {
    const from = match.index + match[1].length;
    const to = from + match[2].length;
    lead.lastIndex = to;
    if (!lang.isWeakName.test(cleanName(lower.slice(0, from))) && hasLetter(lower.slice(to))) {
      const found = result(from, from);
      if (found) return found;
    }
    match = lead.exec(lower);
  }
  return undefined;
}

// ── здоровье и цели (spec 020) ───────────────────────────────────────────────

function parseHealth(
  text: string, lower: string, edits: NumeralEdit[], ctx: QuickContext, allowed: Set<QuickKind>, lang: Lang,
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
    return settle(parseWorkout(text, lower, edits, ctx, lang));
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
function parseWorkout(
  text: string, lower: string, edits: NumeralEdit[], ctx: QuickContext, lang: Lang,
): QuickDraft | undefined {
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
  // У записи тренировки нет ни описания, ни меток: название не делится
  const base = parseText(rest, edits, {
    ...ctx, kind: 'event', kinds: undefined, skip: [...(ctx.skip || []), 'description', ...MARKER_FIELDS],
  }, lang);
  const isRecord = Boolean(distanceKm || exercises.length)
    || (!base.start && !base.repeat && (base.day || ctx.today) <= ctx.today);
  if (!isRecord && ctx.kind !== 'workout') return undefined;
  const hasContent = Boolean(distanceKm || exercises.length || base.minutes);
  // «бег 28 мин» — запись тренировки либо дело с длительностью: второе чтение остаётся вариантом
  const plainKinds = (['task', 'event'] as const).filter((kind) => !ctx.kinds || ctx.kinds.includes(kind));
  const other = !ctx.kind && plainKinds.length
    ? parseText(text, edits, { ...ctx, kinds: plainKinds, pick: undefined }, lang).kind : undefined;
  return {
    kind: 'workout',
    alternatives: other ? [{ field: 'kind', pick: other }] : undefined,
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
  // «сон 23:30-07:00» — режим: когда ложиться и вставать (минуты от полуночи); «сон 8ч» — длительность
  take(
    `(?:${names.sleep})\\s+(?:(?:${words.from})\\s+)?(${HOUR}):(${MINUTE})\\s*(?:${DASH}|${words.to})\\s*`
    + `(${HOUR}):(${MINUTE})`,
    (g) => {
      changes.health.bedtime = (Number(g[1]) % 24) * MINUTES_IN_HOUR + Number(g[2]);
      changes.health.wakeTime = (Number(g[3]) % 24) * MINUTES_IN_HOUR + Number(g[4]);
    },
  );
  take(`(?:${names.sleep})\\s*(${NUM})(?![:\\d])\\s*(?:${words.hour})?`, (g) => {
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
