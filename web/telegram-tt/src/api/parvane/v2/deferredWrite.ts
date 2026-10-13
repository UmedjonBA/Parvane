// Отложенная запись снимка (perf A1): изменения помечают снимок «грязным», на
// диск он уходит не чаще раза в `debounceMs` и не позже `maxDelayMs` после
// первого изменения; `flush()` пишет сразу (перед ack, при уходе со страницы).
// Снимок снимается синхронно в момент решения о записи (состояние движка к
// этому моменту согласовано), сама запись идёт одна за другой.

type Options<T> = {
  debounceMs: number;
  maxDelayMs: number;
  /** Снимок к записи; undefined — писать нечего (движок не поднят). */
  snapshot: () => T | undefined;
  store: (value: T) => Promise<void>;
  onError?: (error: unknown) => void;
};

export function createDeferredWrite<T>(options: Options<T>) {
  let isDirty = false;
  let firstMarkAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  function schedule() {
    if (timer) clearTimeout(timer);
    const deadline = firstMarkAt + options.maxDelayMs;
    const delay = Math.max(0, Math.min(options.debounceMs, deadline - Date.now()));
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  }

  /** Состояние изменилось — записать позже. */
  function mark() {
    if (!isDirty) {
      isDirty = true;
      firstMarkAt = Date.now();
    }
    schedule();
  }

  /** Записать сейчас, если есть что; возвращает завершение записи. */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!isDirty) return chain;
    isDirty = false;
    const value = options.snapshot();
    if (value === undefined) return chain;
    chain = chain.then(() => options.store(value)).catch((error: unknown) => options.onError?.(error));
    return chain;
  }

  /** Отменить отложенную запись (снимок больше не нужен: состояние стирают). */
  function discard() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    isDirty = false;
  }

  /** Завершение уже начатых записей — без новой записи (перед стиранием/чтением с диска). */
  function settled(): Promise<void> {
    return chain;
  }

  return {
    mark,
    flush,
    discard,
    settled,
    isDirty: () => isDirty,
  };
}
