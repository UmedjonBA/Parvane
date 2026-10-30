// Числительные словами для ввода текстом (spec 017): проход перед распознавателями. Слова-числа и
// разговорные обозначения времени заменяются цифрами, которые распознаватели уже понимают («в пять» →
// «в 5», «полтретьего» → «2:30», «half past two» → «2:30»). Каждая замена помнит исходные слова: если её
// цифры никто не забрал, в название возвращается то, что набрал пользователь («купить пять яблок»).
//
// Правило: слово-число значит ровно то же, что цифра на его месте. Исключение — разговорные часы, у
// которых цифровой записи нет («полтретьего», «без четверти пять», «четверть шестого», «пять минут
// шестого», half past, quarter to/past): они двенадцатичасовые, половину суток выбирает разбор по окну дня
// (`isLoose`).

export type NumeralLang = 'ru' | 'en';
// Замена: участок `from…to` переписанной строки (текст `value`) стоит на месте слов `source`
export type NumeralEdit = { from: number; to: number; value: string; source: string; isLoose?: boolean };
export type NumeralRewrite = { text: string; edits: NumeralEdit[] };

type Token = { word: string; from: number; to: number };
type Found = {
  // Сколько слов занимает замена и сколько слов перед ней пропущено (предлог остаётся как есть)
  count: number;
  lead?: number;
  value: string;
  isLoose?: boolean;
};
type Numbers = Record<string, number>;

// Словарь без прототипа: слово «constructor» или «toString» из текста не находит унаследованное свойство
function dictionary(entries: Numbers): Numbers {
  // eslint-disable-next-line no-null/no-null
  return Object.assign(Object.create(null) as Numbers, entries);
}
type Matcher = (
  at: (index: number) => string | undefined,
  isJoined: (index: number, isHyphenOk?: boolean) => boolean,
  gapAfter: (index: number) => string,
) => Found | undefined;

const MINUTES_IN_HOUR = 60;
const HOURS_ON_DIAL = 12;
const MAX_HOUR = 23;
const FIRST_TENS = 20;
const TEN = 10;

const RU_CARDINALS: Numbers = dictionary({
  ноль: 0,
  один: 1,
  одна: 1,
  одно: 1,
  одну: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
});
// Родительный падеж: «с десяти до двенадцати», «без пятнадцати пять»
const RU_GENITIVES: Numbers = dictionary({
  одного: 1,
  одной: 1,
  двух: 2,
  трех: 3,
  четырех: 4,
  пяти: 5,
  шести: 6,
  семи: 7,
  восьми: 8,
  девяти: 9,
  десяти: 10,
  одиннадцати: 11,
  двенадцати: 12,
  тринадцати: 13,
  четырнадцати: 14,
  пятнадцати: 15,
  шестнадцати: 16,
  семнадцати: 17,
  восемнадцати: 18,
  девятнадцати: 19,
  двадцати: 20,
  тридцати: 30,
  сорока: 40,
  пятидесяти: 50,
});
// «Третьего» в «полтретьего» — идёт третий час: 2:30
const RU_HOUR_OF: Numbers = dictionary({
  первого: 1,
  второго: 2,
  третьего: 3,
  четвертого: 4,
  пятого: 5,
  шестого: 6,
  седьмого: 7,
  восьмого: 8,
  девятого: 9,
  десятого: 10,
  одиннадцатого: 11,
  двенадцатого: 12,
});
const RU_HALF = new Set(['пол', 'половина', 'половине', 'половину']);
const RU_MINUTE = new Set(['минут', 'минута', 'минуты', 'минуту']);
const RU_AT = new Set(['в', 'с', 'до']);
const RU_FROM_TO = new Set(['с', 'до']);
const RU_DAYPART = new Set(['дня', 'ночи']);
const RU_HOUR = /^час(?:а|ов)?$/;

const EN_CARDINALS: Numbers = dictionary({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
});
const EN_AT = new Set(['at', 'from', 'to', 'till', 'until', 'by']);
const EN_PAST = new Set(['past', 'after']);
const EN_MINUTE = new Set(['minute', 'minutes']);
const EN_HOUR = /^(?:hours?|hrs?)$/;

function pad(value: number) {
  return String(value).padStart(2, '0');
}

// Час на циферблате: 0 — это 12
function clock(hour: number, minute: number): Pick<Found, 'value' | 'isLoose'> | undefined {
  if (hour < 0 || hour >= HOURS_ON_DIAL || minute < 0 || minute >= MINUTES_IN_HOUR) return undefined;
  return { value: `${hour || HOURS_ON_DIAL}:${pad(minute)}`, isLoose: true };
}

// «До получаса»: N минут до часа H
function clockBefore(hour: number, minutes: number) {
  return minutes > 0 && minutes < MINUTES_IN_HOUR && hour >= 1 && hour <= HOURS_ON_DIAL
    ? clock(hour - 1, MINUTES_IN_HOUR - minutes) : undefined;
}

function isDialHour(hour: number | undefined): hour is number {
  return hour !== undefined && hour >= 1 && hour <= HOURS_ON_DIAL;
}

// Число из одного либо двух слов («двадцать пять», «twenty-five») начиная со слова `index`
function numberAt(
  numbers: Numbers, index: number, at: (index: number) => string | undefined,
  isJoined: (index: number, isHyphenOk?: boolean) => boolean,
) {
  const first = numbers[at(index) || ''];
  if (first === undefined) return undefined;
  const unit = numbers[at(index + 1) || ''];
  if (first >= FIRST_TENS && first % TEN === 0 && unit !== undefined && unit > 0 && unit < TEN
    && isJoined(index, true)) {
    return { value: first + unit, count: 2 };
  }
  return { value: first, count: 1 };
}

// Час и минуты после предлога: «в десять тридцать», «at ten thirty», «в семь ноль пять»
function hourMinuteAt(
  numbers: Numbers, zero: string, index: number, at: (index: number) => string | undefined,
  isJoined: (index: number, isHyphenOk?: boolean) => boolean,
): Found | undefined {
  const hour = numberAt(numbers, index, at, isJoined);
  if (!hour || hour.value > MAX_HOUR || !isJoined(index + hour.count - 1)) return undefined;
  const next = index + hour.count;
  if (at(next) === zero) {
    const unit = numbers[at(next + 1) || ''];
    if (unit === undefined || unit >= TEN || !isJoined(next)) return undefined;
    return { count: hour.count + 2, value: `${hour.value}:${pad(unit)}` };
  }
  const minute = numberAt(numbers, next, at, isJoined);
  if (!minute || minute.value < TEN || minute.value >= MINUTES_IN_HOUR) return undefined;
  return { count: hour.count + minute.count, value: `${hour.value}:${pad(minute.value)}` };
}

const matchRu: Matcher = (at, isJoined) => {
  const word = at(0)!;
  const next = at(1);
  // «полтретьего», «пол третьего», «пол-третьего», «половина третьего»
  const glued = word.startsWith('пол') ? RU_HOUR_OF[word.slice(3)] : undefined;
  if (glued) return { count: 1, ...clock(glued - 1, MINUTES_IN_HOUR / 2)! };
  if (RU_HALF.has(word) && next && RU_HOUR_OF[next] && isJoined(0, true)) {
    return { count: 2, ...clock(RU_HOUR_OF[next] - 1, MINUTES_IN_HOUR / 2)! };
  }
  // «без пятнадцати пять», «без четверти пять», «без пяти минут час»
  if (word === 'без' && isJoined(0)) {
    const minutes = next === 'четверти' ? { value: 15, count: 1 } : numberAt(RU_GENITIVES, 1, at, isJoined);
    if (minutes && isJoined(minutes.count)) {
      const skipped = RU_MINUTE.has(at(1 + minutes.count) || '') && isJoined(1 + minutes.count) ? 1 : 0;
      const hourWord = at(1 + minutes.count + skipped);
      const hour = hourWord === 'час' ? 1 : RU_CARDINALS[hourWord || ''];
      const found = isDialHour(hour) ? clockBefore(hour, minutes.value) : undefined;
      if (found) return { count: 2 + minutes.count + skipped, ...found };
    }
  }
  // «четверть шестого»
  if (word === 'четверть' && next && RU_HOUR_OF[next] && isJoined(0)) {
    return { count: 2, ...clock(RU_HOUR_OF[next] - 1, MINUTES_IN_HOUR / 4)! };
  }
  const number = numberAt(RU_CARDINALS, 0, at, isJoined);
  if (number) {
    const after = at(number.count);
    const isAfterJoined = isJoined(number.count - 1);
    // «пять минут шестого»
    const hourOf = RU_HOUR_OF[at(number.count + 1) || ''];
    if (after && RU_MINUTE.has(after) && hourOf && isAfterJoined && isJoined(number.count)) {
      const found = clock(hourOf - 1, number.value);
      if (found && number.value > 0) return { count: number.count + 2, ...found };
    }
    // «два с половиной часа»
    if (after === 'с' && at(number.count + 1) === 'половиной' && RU_HOUR.test(at(number.count + 2) || '')
      && isAfterJoined && isJoined(number.count) && isJoined(number.count + 1)) {
      return { count: number.count + 2, value: `${number.value}.5` };
    }
    return { count: number.count, value: String(number.value) };
  }
  if (!next || !isJoined(0)) return undefined;
  // «на час» — длительность, «в час» — время; «на час дня» и «час пик» — не они
  if (next === 'час') {
    const tail = isJoined(1) ? at(2) : undefined;
    if (word === 'на' && !RU_DAYPART.has(tail || '') && tail !== 'с' && tail !== 'пик') {
      return { count: 2, value: '1 ч' };
    }
    if (word === 'в' && tail !== 'пик') return { count: 1, lead: 1, value: '1' };
  }
  if (RU_AT.has(word)) {
    const pair = hourMinuteAt(RU_CARDINALS, 'ноль', 1, at, isJoined);
    if (pair) return { ...pair, lead: 1 };
  }
  if (RU_FROM_TO.has(word)) {
    const genitive = numberAt(RU_GENITIVES, 1, at, isJoined);
    if (genitive) return { count: genitive.count, lead: 1, value: String(genitive.value) };
  }
  return undefined;
};

const matchEn: Matcher = (at, isJoined, gapAfter) => {
  const word = at(0)!;
  const next = at(1);
  // «half past two»
  if (word === 'half' && next === 'past' && isJoined(0) && isJoined(1)) {
    const hour = EN_CARDINALS[at(2) || ''];
    if (isDialHour(hour)) return { count: 3, ...clock(hour % HOURS_ON_DIAL, MINUTES_IN_HOUR / 2)! };
  }
  // «quarter to five», «a quarter past five»
  const quarter = word === 'quarter' ? 0 : (word === 'a' && next === 'quarter' && isJoined(0) ? 1 : -1);
  if (quarter >= 0 && isJoined(quarter) && isJoined(quarter + 1)) {
    const link = at(quarter + 1) || '';
    const hour = EN_CARDINALS[at(quarter + 2) || ''];
    if (isDialHour(hour)) {
      const found = link === 'to' ? clockBefore(hour, MINUTES_IN_HOUR / 4)
        : EN_PAST.has(link) ? clock(hour % HOURS_ON_DIAL, MINUTES_IN_HOUR / 4) : undefined;
      if (found) return { count: quarter + 3, ...found };
    }
  }
  const number = numberAt(EN_CARDINALS, 0, at, isJoined);
  if (number) {
    const isAfterJoined = isJoined(number.count - 1);
    const hasMinutes = EN_MINUTE.has(at(number.count) || '') && isAfterJoined && isJoined(number.count);
    const linkAt = number.count + (hasMinutes ? 1 : 0);
    const link = at(linkAt) || '';
    const hour = EN_CARDINALS[at(linkAt + 1) || ''];
    // «ten past five», «ten minutes to five»; «ten to five» без «minutes» — диапазон, а не время
    if (isDialHour(hour) && isJoined(linkAt - 1) && isJoined(linkAt)) {
      const found = EN_PAST.has(link) ? clock(hour % HOURS_ON_DIAL, number.value)
        : link === 'to' && hasMinutes ? clockBefore(hour, number.value) : undefined;
      if (found && number.value > 0) return { count: linkAt + 2, ...found };
    }
    // «two and a half hours»
    if (link === 'and' && !hasMinutes && at(linkAt + 1) === 'a' && at(linkAt + 2) === 'half'
      && EN_HOUR.test(at(linkAt + 3) || '') && isAfterJoined && isJoined(linkAt) && isJoined(linkAt + 1)
      && isJoined(linkAt + 2)) {
      return { count: linkAt + 3, value: `${number.value}.5` };
    }
    // «five o'clock»
    if (at(number.count) === 'o' && at(number.count + 1) === 'clock' && isAfterJoined
      && /^['’]$/.test(gapAfter(number.count))) {
      return { count: number.count + 2, value: String(number.value) };
    }
    return { count: number.count, value: String(number.value) };
  }
  if (!next || !isJoined(0)) return undefined;
  // «for an hour» — длительность; «an hour and a half» разбирает словарь
  if (word === 'for' && (next === 'an' || next === 'a') && at(2) === 'hour' && isJoined(1)
    && !(at(3) === 'and' && isJoined(2))) {
    return { count: 3, value: '1 hr' };
  }
  if (EN_AT.has(word)) {
    const pair = hourMinuteAt(EN_CARDINALS, 'oh', 1, at, isJoined);
    if (pair) return { ...pair, lead: 1 };
  }
  return undefined;
};

const MATCHERS: Record<NumeralLang, Matcher> = { ru: matchRu, en: matchEn };

/** Переписать числительные строки цифрами; `edits` — что на что заменено (позиции в переписанной строке). */
export function rewriteNumerals(text: string, lang: NumeralLang): NumeralRewrite {
  const folded = text.toLowerCase().replace(/ё/g, 'е');
  const none = { text, edits: [] };
  // Свёртка регистра обязана сохранять позиции символов
  if (folded.length !== text.length) return none;
  const tokens: Token[] = [];
  // Слова, слитые с цифрами («v2two»), — не числительные
  const pattern = /[a-zа-я0-9_]+/g;
  let found = pattern.exec(folded);
  while (found) {
    if (!/[0-9_]/.test(found[0])) tokens.push({ word: found[0], from: found.index, to: pattern.lastIndex });
    found = pattern.exec(folded);
  }
  if (!tokens.length) return none;
  const match = MATCHERS[lang];
  const edits: NumeralEdit[] = [];
  let out = '';
  let copied = 0;
  let index = 0;
  while (index < tokens.length) {
    const base = index;
    const at = (offset: number) => tokens[base + offset]?.word;
    const gapAfter = (offset: number) => {
      const left = tokens[base + offset];
      const right = tokens[base + offset + 1];
      return left && right ? folded.slice(left.to, right.from) : '';
    };
    // Слова `offset` и `offset + 1` стоят рядом: между ними только пробелы (либо дефис — «twenty-five»)
    const isJoined = (offset: number, isHyphenOk?: boolean) => {
      const gap = gapAfter(offset);
      return /^[ \t]+$/.test(gap) || (Boolean(isHyphenOk) && gap === '-');
    };
    const result = match(at, isJoined, gapAfter);
    if (!result) {
      index += 1;
    } else {
      const first = tokens[base + (result.lead || 0)];
      const last = tokens[base + (result.lead || 0) + result.count - 1];
      out += text.slice(copied, first.from);
      edits.push({
        from: out.length,
        to: out.length + result.value.length,
        value: result.value,
        source: text.slice(first.from, last.to),
        isLoose: result.isLoose,
      });
      out += result.value;
      copied = last.to;
      index = base + (result.lead || 0) + result.count;
    }
  }
  if (!edits.length) return none;
  return { text: out + text.slice(copied), edits };
}

/**
 * Строка в исходных словах. `marked` — переписанная строка, в которой распознанное заменено пробелами:
 * нетронутая замена возвращает слова пользователя, забранная — пробелы той же длины.
 */
export function restoreNumerals(marked: string, edits: NumeralEdit[]) {
  if (!edits.length) return marked;
  let out = '';
  let copied = 0;
  edits.forEach((edit) => {
    const isIntact = marked.slice(edit.from, edit.to) === edit.value;
    out += marked.slice(copied, edit.from) + (isIntact ? edit.source : ' '.repeat(edit.source.length));
    copied = edit.to;
  });
  return out + marked.slice(copied);
}

/** Позиция переписанной строки в исходной; позиция внутри замены — её край (начало либо конец). */
export function toSourceOffset(position: number, edits: NumeralEdit[], isEnd = false) {
  let shift = 0;
  for (const edit of edits) {
    if (position <= edit.from) break;
    // Внутри замены
    if (position < edit.to) return edit.from + shift + (isEnd ? edit.source.length : 0);
    shift += edit.source.length - (edit.to - edit.from);
  }
  return position + shift;
}
