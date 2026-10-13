// Пачечный запрос по ключам с памятью (perf A3): вызовы за окно сбора
// сливаются в один запрос списком, недавно полученные ключи не запрашиваются
// повторно до истечения TTL. Имена/профили собеседников при старте и на
// каждое входящее раньше уходили по одному запросу на адрес и упирались в
// лимит частоты gateway.

type Options = {
  /** Окно сбора ключей перед запросом, мс. */
  delayMs: number;
  /** Сколько держать ответ, прежде чем спросить снова, мс. */
  ttlMs: number;
  /** Потолок ключей в одном запросе. */
  chunk: number;
  resolve: (keys: string[]) => Promise<void>;
  now?: () => number;
};

export function createBatchedResolver(options: Options) {
  const now = options.now || (() => Date.now());
  const resolvedAt = new Map<string, number>();
  const pending = new Set<string>();
  let waiters: { resolve: () => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flush() {
    timer = undefined;
    const keys = Array.from(pending);
    const settle = waiters;
    pending.clear();
    waiters = [];
    try {
      for (let i = 0; i < keys.length; i += options.chunk) {
        const slice = keys.slice(i, i + options.chunk);
        await options.resolve(slice);
        const at = now();
        slice.forEach((key) => resolvedAt.set(key, at));
      }
    } catch {
      // Ответ не обязателен — следующий запрос повторит
    } finally {
      settle.forEach((waiter) => waiter.resolve());
    }
  }

  /** Запросить ключи; обещание исполняется, когда ушёл запрос с ними. */
  function request(keys: string[], force?: boolean): Promise<void> {
    const at = now();
    keys.forEach((key) => {
      if (!key) return;
      const last = resolvedAt.get(key);
      if (!force && last !== undefined && at - last < options.ttlMs) return;
      pending.add(key);
    });
    if (!pending.size) return Promise.resolve();
    if (!timer) timer = setTimeout(() => void flush(), options.delayMs);
    return new Promise<void>((resolve) => {
      waiters.push({ resolve });
    });
  }

  function isFresh(key: string) {
    const last = resolvedAt.get(key);
    return last !== undefined && now() - last < options.ttlMs;
  }

  function reset() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending.clear();
    resolvedAt.clear();
    const settle = waiters;
    waiters = [];
    settle.forEach((waiter) => waiter.resolve());
  }

  return { request, isFresh, reset };
}
