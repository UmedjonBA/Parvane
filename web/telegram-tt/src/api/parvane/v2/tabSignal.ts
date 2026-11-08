// Живое уведомление о записи в журнал между ВКЛАДКАМИ одного браузера (spec 033). Сервер будит `JournalNotice` только
// прочие устройства аккаунта, а вкладки одного браузера — одно устройство: без этого вторая вкладка узнавала о
// правке первой лишь опросом (раз в минуту), и её устаревший снимок мог вернуть уже снятое (черновик после отправки).

export type JournalKind = 'state' | 'history';

const CHANNEL_PREFIX = 'parvane-journal:';

export function createTabSignal(self: () => string, onSignal: (kind: JournalKind) => void) {
  let channel: BroadcastChannel | undefined;
  let owner = '';

  function ensure() {
    const user = self();
    if (!user || typeof BroadcastChannel === 'undefined') return undefined;
    if (channel && owner === user) return channel;
    channel?.close();
    owner = user;
    channel = new BroadcastChannel(`${CHANNEL_PREFIX}${user}`);
    channel.onmessage = (event: MessageEvent<{ kind?: JournalKind }>) => {
      const kind = event.data?.kind;
      if (kind === 'state' || kind === 'history') onSignal(kind);
    };
    return channel;
  }

  return {
    /** Слушать уведомления других вкладок (подключение журнала). */
    listen: () => {
      ensure();
    },
    /** Эта вкладка записала в журнал — остальные вкладки догоняют сразу. */
    post: (kind: JournalKind) => {
      try {
        ensure()?.postMessage({ kind });
      } catch {
        // канал закрыт — остальные вкладки догонят опросом
      }
    },
    close: () => {
      channel?.close();
      channel = undefined;
      owner = '';
    },
  };
}

// spec 035 T045 (contracts/storage.md, FR-027): события хранилища движка между вкладками одного профиля. Смена
// обёртки DEK (`storage-wrap-changed`: установка/смена/снятие PIN, начало переноса поколения) и переключение
// поколения (`storage-generation-switched`) — остальные вкладки перечитывают корень до следующей записи;
// блокировка (`storage-locked`) — забывают DEK. Канал — по профилю хранилища, не по адресу.
export type StorageSignal = 'storage-wrap-changed' | 'storage-locked' | 'storage-generation-switched';

const STORAGE_SIGNALS: StorageSignal[] = ['storage-wrap-changed', 'storage-locked', 'storage-generation-switched'];
const STORAGE_CHANNEL_PREFIX = 'parvane-store:';

export function createStorageSignal(profile: string, tab: string, onSignal: (kind: StorageSignal) => void) {
  const channel = typeof BroadcastChannel === 'undefined'
    ? undefined
    : new BroadcastChannel(`${STORAGE_CHANNEL_PREFIX}${profile}`);
  if (channel) {
    channel.onmessage = (event: MessageEvent<{ kind?: StorageSignal; tab?: string }>) => {
      const { kind, tab: from } = event.data || {};
      if (kind && STORAGE_SIGNALS.includes(kind) && from !== tab) onSignal(kind);
    };
  }
  return {
    post: (kind: StorageSignal) => {
      try {
        channel?.postMessage({ kind, tab });
      } catch {
        // канал закрыт — вкладка сверит корень перед следующей записью
      }
    },
    close: () => channel?.close(),
  };
}
