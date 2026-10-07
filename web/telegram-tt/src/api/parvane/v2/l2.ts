// Режим чата «усиленная приватность» (L2, spec 007 FR-036, правило L2-1).
// Сам режим ведёт движок: подписанные операции участников личного чата,
// политика в журнале группы, выравнивание размеров конвертов. Здесь — решение
// для эфемерных каналов v1-пути (typing, presence) и память о режиме между
// запусками.
//
// Память нужна потому, что движок поднимается уже после входа, а клиент к
// этому моменту публикует своё присутствие и подписывается на чужое. Режим,
// известный с прошлого запуска, действует сразу: пока движок не готов,
// решение принимается по памяти (в закрытую сторону).

/** Состояние режима в чате (JSON `l2Direct`/`l2Group` движка). */
export type L2State = {
  active: boolean;
  mine: boolean;
  enabledBy: string[];
  pad: boolean;
  ephemeralAllowed: boolean;
};

type L2Memo = {
  // Чаты (адрес собеседника или группы), где эфемерные каналы закрыты
  blocked: string[];
  // Последняя известная политика группы: служебное сообщение о её смене не
  // должно повторяться после перезагрузки
  groups: Record<string, boolean>;
};

type L2GateDeps = {
  getSelf: () => string;
  /** Состояние чата по движку; `undefined` — движок ещё не готов. */
  readEngine: (address: string) => L2State | undefined;
  /** Можно ли публиковать присутствие по движку; `undefined` — движок не готов. */
  readEnginePresence: () => boolean | undefined;
};

export function parseL2State(json: string): L2State | undefined {
  try {
    const raw = JSON.parse(json) as Partial<L2State>;
    return {
      active: Boolean(raw.active),
      mine: Boolean(raw.mine),
      enabledBy: Array.isArray(raw.enabledBy) ? raw.enabledBy : [],
      pad: Boolean(raw.pad),
      ephemeralAllowed: raw.ephemeralAllowed !== false,
    };
  } catch {
    return undefined;
  }
}

export function createL2Gate(deps: L2GateDeps) {
  let cached: { key: string; memo: L2Memo } | undefined;

  function memoKey() {
    return `parvane:v2l2:${deps.getSelf()}`;
  }

  function loadMemo(): L2Memo {
    const key = memoKey();
    if (cached?.key === key) return cached.memo;
    let memo: L2Memo = { blocked: [], groups: {} };
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '{}') as Partial<L2Memo>;
      memo = { blocked: Array.isArray(raw.blocked) ? raw.blocked : [], groups: raw.groups || {} };
    } catch {
      // приватный режим/битая запись — память пуста, решает движок
    }
    cached = { key, memo };
    return memo;
  }

  function saveMemo(memo: L2Memo) {
    const key = memoKey();
    cached = { key, memo };
    try {
      localStorage.setItem(key, JSON.stringify(memo));
    } catch {
      // приватный режим — память живёт до перезагрузки
    }
  }

  /** Запомнить решение по чату; true — оно изменилось. */
  function remember(address: string, isBlocked: boolean) {
    const memo = loadMemo();
    if (memo.blocked.includes(address) === isBlocked) return false;
    saveMemo({
      ...memo,
      blocked: isBlocked ? [...memo.blocked, address] : memo.blocked.filter((item) => item !== address),
    });
    return true;
  }

  /** Состояние чата по движку (попутно обновляет память). */
  function state(address: string) {
    const current = deps.readEngine(address);
    if (current) remember(address, !current.ephemeralAllowed);
    return current;
  }

  /** Можно ли слать и показывать typing/presence в этом чате. */
  function ephemeralAllowed(address: string) {
    const current = state(address);
    return current ? current.ephemeralAllowed : !loadMemo().blocked.includes(address);
  }

  /** Публиковать ли своё присутствие: оно одно на аккаунт. */
  function presenceAllowed() {
    const byEngine = deps.readEnginePresence();
    return byEngine !== undefined ? byEngine : !loadMemo().blocked.length;
  }

  // Политика группы по журналу. true — она отличается от последней известной
  // (нужно служебное сообщение); первое знакомство с группой при выключенном
  // режиме изменением не считается
  function noteGroupPolicy(address: string, isEnabled: boolean) {
    const memo = loadMemo();
    const known = memo.groups[address];
    if (known === isEnabled) return false;
    saveMemo({ ...memo, groups: { ...memo.groups, [address]: isEnabled } });
    return (known ?? false) !== isEnabled;
  }

  /** Чат покинут или удалён: память о нём больше не действует. */
  function forget(address: string) {
    const memo = loadMemo();
    if (!memo.blocked.includes(address) && memo.groups[address] === undefined) return;
    const { [address]: _removed, ...groups } = memo.groups;
    saveMemo({ blocked: memo.blocked.filter((item) => item !== address), groups });
  }

  // Движок поднялся: сверить память с ним. Возвращает чаты, где решение
  // изменилось (режим сняли или включили, пока это устройство было выключено)
  function reconcile(known: string[]) {
    const candidates = new Set([...loadMemo().blocked, ...known]);
    return [...candidates].filter((address) => {
      const current = deps.readEngine(address);
      return current ? remember(address, !current.ephemeralAllowed) : false;
    });
  }

  return {
    ephemeralAllowed,
    forget,
    noteGroupPolicy,
    presenceAllowed,
    reconcile,
    state,
  };
}
