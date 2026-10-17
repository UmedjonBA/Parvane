// Ровный поток отправки в режиме L2 (spec 025): пока у пользователя есть хотя бы один чат с «усиленной
// приватностью», запечатанные записи (личные, групповые, квитанции) уходят тактами — раз в такт ровно одна:
// настоящая из очереди либо пустышка себе (шум). По времени и размеру кадров нельзя понять, когда человек
// пишет. Без L2 — отправка сразу, как раньше.

export type L2TickDeps = {
  isActive: () => boolean;
  send: (method: string, body: Uint8Array, dest?: string) => Promise<Uint8Array>;
  makeCover: () => { method: string; body: Uint8Array } | undefined;
  log: (text: string) => void;
  tickMs?: number;
  jitterMs?: number;
  random?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type Queued = {
  method: string;
  body: Uint8Array;
  // Сервер объекта (spec 028)
  dest?: string;
  resolve: (value: Uint8Array) => void;
  reject: (error: unknown) => void;
};

// Такт 5 с ± 2 с: ~12 записей в минуту; сообщение из двух записей (собеседнику и своим устройствам) уходит
// за 1–2 такта
export const L2_TICK_MS = 5000;
export const L2_TICK_JITTER_MS = 2000;
// Методы, которые идут тактами: доставка записей. Сигналы звонка — сразу (иначе звонок не соединится)
export const L2_TICKED_METHODS = new Set(['msg.deliver_sealed', 'msg.deliver_group']);

export function createL2Ticker(deps: L2TickDeps) {
  const tickMs = deps.tickMs ?? L2_TICK_MS;
  const jitterMs = deps.jitterMs ?? L2_TICK_JITTER_MS;
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const queue: Queued[] = [];
  let timer: unknown;
  let covers = 0;

  function nextDelay() {
    return Math.max(1, Math.round(tickMs + (random() * 2 - 1) * jitterMs));
  }

  function schedule() {
    if (timer !== undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      void tick();
    }, nextDelay());
  }

  async function tick() {
    if (!deps.isActive()) {
      // Режим выключили — накопленное уходит сразу, шума больше нет
      queue.splice(0).forEach(sendNow);
      return;
    }
    schedule();
    const item = queue.shift();
    if (item) {
      sendNow(item);
      return;
    }
    const cover = deps.makeCover();
    if (!cover) return;
    covers += 1;
    try {
      await deps.send(cover.method, cover.body);
    } catch (error) {
      deps.log(`L2: пустышка не ушла: ${String(error)}`);
    }
  }

  function sendNow(item: Queued) {
    deps.send(item.method, item.body, item.dest).then(item.resolve, item.reject);
  }

  /** Отправить запись: в режиме L2 — в очередь тактов, иначе сразу. */
  function submit(method: string, body: Uint8Array, dest?: string): Promise<Uint8Array> {
    if (!L2_TICKED_METHODS.has(method) || !deps.isActive()) return deps.send(method, body, dest);
    schedule();
    return new Promise((resolve, reject) => {
      queue.push({
        method, body, dest, resolve, reject,
      });
    });
  }

  /** Включить такты (шум идёт, пока включён режим L2); вызывать при подъёме движка и смене режима. */
  function refresh() {
    if (deps.isActive()) schedule();
  }

  function stop() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    queue.splice(0).forEach(sendNow);
  }

  return {
    submit,
    refresh,
    stop,
    pending: () => queue.length,
    coversSent: () => covers,
  };
}
