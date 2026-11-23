type Json = Record<string, unknown>;
type Call = (method: string, request: Json) => Promise<Json>;

const MAX_ATTEMPTS = 4;
const MIN_WAIT_MS = 250;
const MAX_WAIT_MS = 4000;

// Parvane («Музыка»): экраны макета 23 ноя зовут сервер часто (главная, поиск по серверу и каталогу, ход
// скачивания). Отказ шлюза «слишком часто» — не ошибка экрана: запрос повторяется после подсказанной паузы
export function createMusicCall(call: Call): Call {
  return async (method, request) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(method, request);
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !String(err).includes('RATE_LIMITED')) throw err;
        const hinted = (err as { retryAfterMs?: number }).retryAfterMs || 0;
        const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS * attempt, hinted));
        await new Promise((resolve) => {
          setTimeout(resolve, wait);
        });
      }
    }
  };
}
