// Кто говорит в групповом звонке (доска `PhCalls`): уровень звука по выборкам анализатора и удержание, чтобы
// подпись «говорит» не мигала между словами

// Порог среднеквадратичного уровня (0…1) и сколько держать «говорит» после последнего громкого замера
export const SPEAKING_LEVEL = 0.03;
export const SPEAKING_HOLD_MS = 700;

/** Уровень звука по выборке `getByteTimeDomainData` (тишина — 128). */
export function measureLevel(samples: Uint8Array) {
  if (!samples.length) return 0;
  let sum = 0;
  samples.forEach((sample) => {
    const value = (sample - 128) / 128;
    sum += value * value;
  });
  return Math.sqrt(sum / samples.length);
}

/** Новый замер: `lastLoudAt` — когда каждый был громким в последний раз; ушедшие из `levels` забываются. */
export function updateSpeakers(levels: Record<string, number>, lastLoudAt: Record<string, number>, now: number) {
  const next: Record<string, number> = {};
  Object.keys(levels).forEach((key) => {
    const loudAt = levels[key] >= SPEAKING_LEVEL ? now : lastLoudAt[key];
    if (loudAt !== undefined) next[key] = loudAt;
  });
  const speakers = Object.keys(next).filter((key) => now - next[key] < SPEAKING_HOLD_MS).sort();
  return { lastLoudAt: next, speakers };
}
