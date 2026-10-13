// Индекс `uuid → строка истории` в памяти (perf A2). Мутации v2 (квитанция,
// реакция, правка, удаление, закреп) находят цель по uuid; раньше промах по
// карте контроллера читал и расшифровывал ВСЮ историю из IndexedDB на каждый
// вызов — после перезагрузки открыть чат с 50 непрочитанными значило 50 полных
// проходов. Индекс наполняют восстановление из кэша и конвейер отображения;
// промах стоит одного полного чтения за сессию, дальше — чтение одной записи
// (строка могла появиться в кэше мимо индекса, например из другой вкладки).

import type { WireStoredMessage } from '../wire';

type Deps = {
  /** Вся история (кэш + журнал исходящих) — один раз за сессию при промахе. */
  loadAll: () => Promise<WireStoredMessage[]>;
  /** Одна запись кэша по uuid — для промахов после полного чтения. */
  loadOne?: (uuid: string) => Promise<WireStoredMessage | undefined>;
};

export function createMessageIndex(deps: Deps) {
  const byUuid = new Map<string, WireStoredMessage>();
  let fullLoad: Promise<void> | undefined;

  function set(stored: WireStoredMessage) {
    byUuid.set(stored.id, stored);
  }

  function get(uuid: string) {
    return byUuid.get(uuid);
  }

  function remove(uuid: string) {
    byUuid.delete(uuid);
  }

  function loadAllOnce() {
    if (!fullLoad) {
      fullLoad = deps.loadAll().then((rows) => {
        rows.forEach((row) => {
          if (!byUuid.has(row.id)) byUuid.set(row.id, row);
        });
      }).catch(() => undefined);
    }
    return fullLoad;
  }

  async function find(uuid: string): Promise<WireStoredMessage | undefined> {
    const hit = byUuid.get(uuid);
    if (hit) return hit;
    const isFirstMiss = !fullLoad;
    await loadAllOnce();
    const afterLoad = byUuid.get(uuid);
    if (afterLoad || isFirstMiss || !deps.loadOne) return afterLoad;
    const one = await deps.loadOne(uuid).catch(() => undefined);
    if (one) byUuid.set(uuid, one);
    return one;
  }

  function clear() {
    byUuid.clear();
    fullLoad = undefined;
  }

  return {
    set,
    get,
    remove,
    find,
    clear,
    size: () => byUuid.size,
  };
}

export type MessageIndex = ReturnType<typeof createMessageIndex>;
