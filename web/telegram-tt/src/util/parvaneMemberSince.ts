// «участник с 16 ноября» / «участник с марта» (доска `RpChat`, список жалоб): недавно вступивший — день и месяц,
// давний — только месяц (год — у прошлых лет). Месяц без числа после «с» стоит в родительном падеже; `Intl` даёт его
// только вместе с числом, поэтому для русского — своя таблица

const RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const RU_MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function formatMemberSince(ms: number, nowMs: number, locale: string) {
  const date = new Date(ms);
  const isThisYear = date.getFullYear() === new Date(nowMs).getFullYear();
  const year = isThisYear ? undefined : 'numeric';
  if (nowMs - ms < RECENT_DAYS * DAY_MS) {
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year });
  }
  if (locale.toLowerCase().startsWith('ru')) {
    const month = RU_MONTHS_GENITIVE[date.getMonth()];
    return isThisYear ? month : `${month} ${date.getFullYear()}`;
  }
  return date.toLocaleDateString(locale, { month: 'long', year });
}
