// Parvane (spec 039): оформление значений «Музыки» — длительность трека и альбома

const SECONDS_IN_MINUTE = 60;
const MINUTES_IN_HOUR = 60;

/** Длительность трека: `3:42`, от часа — `1:02:05`. */
export function formatTrackTime(totalSecs: number) {
  const total = Math.max(0, Math.floor(totalSecs));
  const seconds = String(total % SECONDS_IN_MINUTE).padStart(2, '0');
  const minutes = Math.floor(total / SECONDS_IN_MINUTE);
  if (minutes < MINUTES_IN_HOUR) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / MINUTES_IN_HOUR)}:${String(minutes % MINUTES_IN_HOUR).padStart(2, '0')}:${seconds}`;
}

/** Длительность списка в часах и минутах — для подписи «1 ч 52 мин». */
export function splitListTime(totalSecs: number) {
  const minutes = Math.round(Math.max(0, totalSecs) / SECONDS_IN_MINUTE);
  return { hours: Math.floor(minutes / MINUTES_IN_HOUR), minutes: minutes % MINUTES_IN_HOUR };
}

/** Цвет заглушки обложки по id: один из тонов схемы, один и тот же у одного альбома. */
export function coverTone(id: string) {
  const tones = ['purple', 'blue', 'orange', 'green', 'red', 'aqua'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 9973;
  return `var(--pv-${tones[hash % tones.length]})`;
}

/** Объём для подписи расхода: число и единица — гигабайты с десятой либо целые мегабайты (двоичные). */
export function splitBytes(bytes: number) {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) return { value: megabytes / 1024, isGigabytes: true };
  return { value: Math.round(megabytes), isGigabytes: false };
}

/** Сколько осталось качать на устройство: по средней скорости и среднему размеру уже скачанных треков; данных
 * мало — `undefined`. Минуты — не меньше одной. */
export function estimateOfflineLeft(doneBytes: number, busyMs: number, doneCount: number, leftCount: number) {
  if (!doneCount || !busyMs || !doneBytes || !leftCount) return undefined;
  const bytes = Math.round((doneBytes / doneCount) * leftCount);
  const minutes = Math.max(1, Math.round((bytes / (doneBytes / busyMs)) / 60000));
  return { bytes, minutes };
}

/** «12 ноя 2026, 21:14» — когда добавлен и правлен файл («Откуда файл»). */
export function formatMusicDate(lang: { code: string }, ms: number) {
  return new Intl.DateTimeFormat(lang.code, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms)).replace(/\.(?=,| )/, '');
}
