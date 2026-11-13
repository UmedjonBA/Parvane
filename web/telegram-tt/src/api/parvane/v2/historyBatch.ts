// Окно пачки журнала истории аккаунта (HIST-1 п. 5, S7-3). Журнал (очередь, догон, контрольные точки, замена дальше
// горизонта) с spec 036 ведёт модель движка (`backend/protocol/src/model/mod.rs`, `checkpoint.rs`); web только
// передаёт ей окно пачки: в обычной сборке — умолчание модели (30–120 с), в диаг-сборке сценариев — короткое.

// e2e (только диаг-сборка, `VITE_PARVANE_DIAG_HOOKS=1`): короткое окно пачки, сценарии не ждут по две минуты;
// `localStorage['parvane:e2e:historyBatchMs'] = "мин,макс"` — своё окно
const E2E_BATCH_STORAGE_KEY = 'parvane:e2e:historyBatchMs';
const E2E_BATCH_DEFAULT_MS: [number, number] = [1000, 3000];
const ARE_DIAG_HOOKS_ENABLED = import.meta.env?.VITE_PARVANE_DIAG_HOOKS === '1';

/** Окно пачки записи в журнал для конфигурации модели: `undefined` — умолчание модели (прод). */
export function historyBatchWindow(): [number, number] | undefined {
  if (!ARE_DIAG_HOOKS_ENABLED) return undefined;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(E2E_BATCH_STORAGE_KEY) : undefined;
    const [lo, hi] = (raw || '').split(',').map(Number);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo) return [lo, hi];
  } catch {
    // хранилище недоступно — окно по умолчанию
  }
  return E2E_BATCH_DEFAULT_MS;
}
