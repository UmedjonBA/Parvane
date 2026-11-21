// Даты «Файлов» по доскам: «13 ноя» в строках и меню, «22 ноября» в сроках ссылок; год — только не текущий

const SHORT_MONTH_CHARS = 3;

/** «13 ноя» (ru: три буквы месяца в родительном падеже, как на досках), «Nov 13» — в остальных языках. */
export function formatCloudDayShort(code: string, ms: number, now = Date.now()) {
  const date = new Date(ms);
  const year = date.getFullYear() !== new Date(now).getFullYear() ? ` ${date.getFullYear()}` : '';
  if (code.startsWith('ru')) {
    const month = date.toLocaleDateString(code, { day: 'numeric', month: 'long' }).split(' ')[1] || '';
    return `${date.getDate()} ${month.slice(0, SHORT_MONTH_CHARS)}${year}`;
  }
  return `${date.toLocaleDateString(code, { day: 'numeric', month: 'short' }).replace(/\.$/, '')}${year}`;
}

/** «22 ноября»; не в текущем году — «22 ноября 2027 г.». */
export function formatCloudDayLong(code: string, ms: number, now = Date.now()) {
  const date = new Date(ms);
  const isThisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(code, isThisYear
    ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}
