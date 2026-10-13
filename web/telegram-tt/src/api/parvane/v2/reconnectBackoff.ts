// Повторы подключения (perf A5): задержка растёт 1 → 2 → 4 … до потолка с
// разбросом ±50 % (чтобы вкладки одного сервера не били в него разом), при
// успехе сбрасывается. Одна попытка каждые 3 с без предела, как раньше, после
// неудачного повтора молчала до внешнего толчка.

type Options = {
  baseMs: number;
  maxMs: number;
  /** Источник разброса 0..1 (в тестах — детерминированный). */
  random?: () => number;
};

export function createReconnectBackoff({ baseMs, maxMs, random = Math.random }: Options) {
  let attempt = 0;

  /** Задержка следующей попытки (мс); каждая следующая — длиннее. */
  function next() {
    const base = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
    attempt += 1;
    return Math.round(base * (0.5 + random()));
  }

  function reset() {
    attempt = 0;
  }

  return { next, reset, attempts: () => attempt };
}
