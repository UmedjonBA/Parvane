// Точка «вручную» на экране «Место» (доска `RpChat`): «41.3111, 69.2797» — широта и долгота через запятую,
// пробел или точку с запятой; десятичная запятая не поддерживается (она разделяет числа)

const MAX_LAT = 90;
const MAX_LONG = 180;

export function parseCoordinates(text: string): { lat: number; long: number } | undefined {
  const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 2) return undefined;
  const [lat, long] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(long)) return undefined;
  if (Math.abs(lat) > MAX_LAT || Math.abs(long) > MAX_LONG) return undefined;
  return { lat, long };
}
