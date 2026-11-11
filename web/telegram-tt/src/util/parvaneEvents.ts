// Имена событий окна между провайдером Parvane и интерфейсом (не ключи хранения).

/** spec 035 T117: журнал личного состояния закрыт для записи более новой версией приложения. */
export const STATE_WRITE_BLOCKED_EVENT = 'parvane-state-write-blocked';

/** spec 035 T117: данные на устройстве сохранены более новой версией приложения (модель движка — `TOO_NEW`). */
export const DATA_TOO_NEW_EVENT = 'parvane-data-too-new';
