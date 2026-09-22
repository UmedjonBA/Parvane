// Parvane: один бюджет на ВСЕ кэши расшифрованных медиа (spec 002 FR-024).
// Раньше бюджет знал только `api/parvane/media.ts`, а расшифрованные блобы
// `util/mediaLoader.ts` и окна `util/progressiveLoader.ts` жили в Map без
// лимита — вытеснение в media.ts памяти при этом не освобождало.
//
// Потребители регистрируются здесь: каждый умеет сказать свой объём и
// вытеснить самую давнюю запись. Бюджет превышен — вытесняет тот, кто занимает
// больше; никто не смог — выходим, чтобы не крутиться впустую.
//
// `protectedKey` — запись, которую нельзя трогать в этом проходе (только что
// записанный блоб, файл, который прямо сейчас читают). Без неё вытеснение
// выбрасывало ровно то, ради чего вызывалось.

export const DECRYPTED_MEDIA_BUDGET_BYTES = 256 * 1024 * 1024;

export type BudgetConsumer = {
  name: string;
  usedBytes: () => number;
  // Вытеснить самую давнюю запись, кроме `protectedKey`. true — что-то освободили
  evictOldest: (protectedKey?: string) => boolean;
};

const consumers: BudgetConsumer[] = [];

export function registerBudgetConsumer(consumer: BudgetConsumer) {
  const existing = consumers.findIndex(({ name }) => name === consumer.name);
  if (existing >= 0) consumers.splice(existing, 1, consumer);
  else consumers.push(consumer);
}

export function totalDecryptedBytes() {
  return consumers.reduce((sum, consumer) => sum + consumer.usedBytes(), 0);
}

export function enforceDecryptedMediaBudget(protectedKey?: string) {
  while (totalDecryptedBytes() > DECRYPTED_MEDIA_BUDGET_BYTES) {
    const heaviest = consumers
      .filter((consumer) => consumer.usedBytes() > 0)
      .sort((a, b) => b.usedBytes() - a.usedBytes())[0];
    if (!heaviest || !heaviest.evictOldest(protectedKey)) return;
  }
}
