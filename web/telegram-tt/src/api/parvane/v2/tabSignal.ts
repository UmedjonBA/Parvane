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
