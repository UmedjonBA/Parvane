// Parvane (A9): соединения для блобов по секрету (`cloud.blob.download_cap`,
// анонимный канал). Рукопожатие WS+TLS стоит 150–300 мс, поэтому соединение
// переиспользуется — но только в границах, не связывающих разные блобы на
// сервере сверх того, что он и так видит:
//   - вне серии ключ — сам блоб: окна одного файла идут по одному соединению,
//     разные файлы — по разным (вложения чата: одно соединение на блоб);
//   - серия (`withSeries`: миниатюры папки, тексты заметок, картинки холста —
//     решение пользователя для облака) — одно соединение на всю серию.
// Простой 5 с закрывает соединение, после `maxUses` запросов оно переоткрывается
// (старое дорабатывает начатые потоки и закрывается, когда они кончатся).

export type BlobConnLike = {
  readonly isOpen: boolean;
  close: () => void;
  onClose?: () => void;
};

type Slot<C> = { conn: Promise<C>; uses: number; busy: number };
type Entry<C> = { key: string; current?: Slot<C>; idleTimer?: ReturnType<typeof setTimeout> };

const DEFAULT_IDLE_MS = 5000;
const DEFAULT_MAX_USES = 64;

export function createBlobConnPool<C extends BlobConnLike>(deps: {
  open: () => Promise<C>;
  idleMs?: number;
  maxUses?: number;
}) {
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const maxUses = deps.maxUses ?? DEFAULT_MAX_USES;
  const entries = new Map<string, Entry<C>>();
  let seriesSeq = 0;

  function closeSlot(slot: Slot<C>) {
    slot.conn.then((conn) => conn.close()).catch(() => undefined);
  }

  function drop(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    // Занятые потоки доработают: закрытие сломало бы чужое окно
    if (entry.current && !entry.current.busy) closeSlot(entry.current);
  }

  function openSlot(entry: Entry<C>): Slot<C> {
    const opening = deps.open();
    const slot: Slot<C> = { conn: opening, uses: 0, busy: 0 };
    opening.then((conn) => {
      conn.onClose = () => {
        if (entry.current === slot) entry.current = undefined;
      };
    }).catch(() => {
      if (entry.current === slot) entry.current = undefined;
    });
    entry.current = slot;
    return slot;
  }

  function release(entry: Entry<C>, slot: Slot<C>) {
    slot.busy -= 1;
    if (slot.busy > 0) return;
    // Отставленное соединение (лимит, замена, конец серии) доработало — закрыть
    if (entry.current !== slot || entries.get(entry.key) !== entry) {
      closeSlot(slot);
      return;
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => drop(entry.key), idleMs);
  }

  async function acquire(entry: Entry<C>): Promise<{ conn: C; slot: Slot<C> }> {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    let slot = entry.current;
    if (slot && slot.uses >= maxUses) {
      // Лимит запросов на соединение: новое — для следующих, старое закроется, когда освободится
      if (!slot.busy) closeSlot(slot);
      slot = undefined;
    }
    if (!slot) slot = openSlot(entry);
    slot.uses += 1;
    slot.busy += 1;
    try {
      let conn = await slot.conn;
      if (!conn.isOpen) {
        // Соединение умерло между запросами — переоткрыть (один раз)
        if (entry.current === slot) entry.current = undefined;
        release(entry, slot);
        slot = openSlot(entry);
        slot.uses += 1;
        slot.busy += 1;
        conn = await slot.conn;
      }
      return { conn, slot };
    } catch (e) {
      release(entry, slot);
      throw e;
    }
  }

  /** Выполнить `fn` на соединении ключа `key` (блоб либо серия). */
  async function run<T>(key: string, fn: (conn: C) => Promise<T>): Promise<T> {
    let entry = entries.get(key);
    if (!entry) {
      entry = { key };
      entries.set(key, entry);
    }
    const { conn, slot } = await acquire(entry);
    try {
      return await fn(conn);
    } finally {
      release(entry, slot);
    }
  }

  /** Серия: все запросы внутри `fn` с переданным ключом идут по одному
   * соединению; оно закрывается по концу серии (занятые потоки — доработав). */
  async function withSeries<T>(fn: (key: string) => Promise<T>): Promise<T> {
    const key = `series:${++seriesSeq}`;
    try {
      return await fn(key);
    } finally {
      drop(key);
    }
  }

  function closeAll() {
    [...entries.keys()].forEach(drop);
  }

  return {
    run,
    withSeries,
    closeAll,
    /** Для тестов и диагностики: сколько ключей держат соединение. */
    size: () => entries.size,
  };
}

export type BlobConnPool<C extends BlobConnLike> = ReturnType<typeof createBlobConnPool<C>>;
