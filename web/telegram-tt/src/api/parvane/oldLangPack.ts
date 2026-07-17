// Синтез минимального ApiOldLangPack для старого lang-провайдера. Без него
// легаси-форматтеры дат (список чатов, «был(а) в сети») показывают голые ключи
// вида `Weekday.ShortMonday`. Имена дней/месяцев берём из Intl — без сети.

import type { ApiOldLangPack } from '../types';

const WEEKDAY_KEYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

const MONTH_KEYS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function buildOldLangPack(langCode: string): ApiOldLangPack {
  const pack: ApiOldLangPack = {
    'Weekday.Today': 'Today',
    'Weekday.Yesterday': 'Yesterday',
    formatDateAtTime: '%1$s at %2$s',
    'Time.TodayAt': 'today at %@',
    'Time.YesterdayAt': 'yesterday at %@',
    'Time.AtDate': '%@',
    'Time.JustNow': 'just now',
    'Time.MinutesAgo': { oneValue: '%@ minute ago', otherValue: '%@ minutes ago' },
  };

  const longWeekday = new Intl.DateTimeFormat(langCode, { weekday: 'long' });
  const shortWeekday = new Intl.DateTimeFormat(langCode, { weekday: 'short' });
  // 2024-09-01 — воскресенье; идём по дням недели от него
  WEEKDAY_KEYS.forEach((key, day) => {
    const date = new Date(Date.UTC(2024, 8, 1 + day, 12));
    pack[`Weekday.${key}`] = longWeekday.format(date);
    pack[`Weekday.Short${key}`] = shortWeekday.format(date);
  });

  const longMonth = new Intl.DateTimeFormat(langCode, { month: 'long' });
  const shortMonth = new Intl.DateTimeFormat(langCode, { month: 'short' });
  MONTH_KEYS.forEach((key, month) => {
    const date = new Date(Date.UTC(2024, month, 15, 12));
    pack[`Month.${key}`] = longMonth.format(date);
    pack[`Month.Short${key}`] = shortMonth.format(date);
    pack[`Month.Gen${key}`] = longMonth.format(date);
  });

  return pack;
}
