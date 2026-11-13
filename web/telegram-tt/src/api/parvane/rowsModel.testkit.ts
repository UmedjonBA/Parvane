// Тестовый набор (vitest): строки истории над моделью движка в памяти — тот же `ModelHost` и те же вызовы
// (`rowsApply`, `rowsAll`, `historyPage`, `chatList`), что у профиля web (spec 035 T114).

import type { RowsAll, RowsModel } from './historyRows';

import { PvEngine } from '../../lib/parvane-protocol/parvane_protocol';
import { MemoryModelStore, ModelHost } from './v2/engine';

function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

export async function openRowsModel(user: string, opts: { store?: MemoryModelStore; deviceKey?: Uint8Array } = {}) {
  const store = opts.store || new MemoryModelStore();
  const deviceKey = opts.deviceKey || crypto.getRandomValues(new Uint8Array(32));
  let onDelta: ((delta: Record<string, unknown>) => Promise<void>) | undefined;
  const { host } = await ModelHost.open({
    user,
    device_id: 'd1',
    domain: 'local',
    now_ms: String(Date.now()),
    device_key: b64(deviceKey),
    host_driven: true,
    features: ['wire_rows'],
  }, { store, send: () => undefined, onDelta: (delta) => onDelta?.(delta) }, (cfg) => PvEngine.open(cfg));
  const rows: RowsModel = {
    apply: (args) => host.apply('rowsApply', args),
    all: (what) => Promise.resolve(
      JSON.parse(host.peek<{ result_json?: string }>('rowsAll', what).result_json || '{}') as RowsAll,
    ),
    view: (name, args) => Promise.resolve(host.peek(name, args)),
  };
  return {
    rows,
    host,
    store,
    deviceKey,
    /** Изменения модели — хосту (у профиля web — `onModelDelta` контроллера). */
    setOnDelta: (fn: (delta: Record<string, unknown>) => Promise<void>) => {
      onDelta = fn;
    },
  };
}
