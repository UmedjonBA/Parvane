// Parvane (spec 041, доски `RdPlanSet`, `PhModSettings`): «Напоминать об отбое» на экране «Цели здоровья» —
// настройка этого устройства. Хранится время отбоя из цели сна и текст напоминания: планировщик напоминаний
// (`api/parvane/reminders.ts`, такт 30 с) звенит каждый вечер, «Здоровье» для этого не нужно открывать
export type BedtimeReminder = { bedMin: number; title: string };

const BEDTIME_KEY = 'parvane:bedtime-remind';

export function readBedtimeReminder(): BedtimeReminder | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(BEDTIME_KEY) || 'null') as Partial<BedtimeReminder> | undefined;
    if (!parsed || typeof parsed.bedMin !== 'number' || typeof parsed.title !== 'string') return undefined;
    return { bedMin: parsed.bedMin, title: parsed.title };
  } catch (err) {
    return undefined;
  }
}

export function saveBedtimeReminder(value: BedtimeReminder | undefined) {
  try {
    if (value) localStorage.setItem(BEDTIME_KEY, JSON.stringify(value));
    else localStorage.removeItem(BEDTIME_KEY);
  } catch (err) {
    // Выбор просто не запомнится
  }
}
