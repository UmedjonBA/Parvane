// spec 035 T115 (contracts/migration.md): ход разового переноса данных устройства для экрана хода
// (`components/parvane/ParvaneMigrationOverlay.tsx`). Перенос идёт в провайдере (главный поток), экран слушает
// событие окна: этапы — формат хранилища (`parvane-e2e-v2` → `parvane-store-v3`) и состояние клиента в модели
// движка (`migrateStep`).
export type MigrationPhase = 'storage' | 'engine';

export type MigrationProgress = {
  phase: MigrationPhase;
  active: boolean;
  done: number;
  total: number;
  error?: string;
};

export const MIGRATION_EVENT = 'parvane-migration';

export function reportMigration(progress: MigrationProgress) {
  try {
    window.dispatchEvent(new CustomEvent<MigrationProgress>(MIGRATION_EVENT, { detail: progress }));
  } catch {
    // вне браузера (тесты без окна) показывать некому
  }
}
