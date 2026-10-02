import { useEffect, useState } from '../lib/teact/teact';

import { callApi } from '../api/gramjs';
import useLastCallback from './useLastCallback';

// Parvane: режим чата «усиленная приватность» (L2, протокол v2). Личный чат —
// своё предпочтение (`isMine`); группа v2 — политика журнала (`isActive`)
type ParvaneChatL2 = {
  isAvailable: boolean;
  isActive?: boolean;
  isMine?: boolean;
};

// Режим сменился (собеседник, своё другое устройство, журнал группы) —
// событие шлёт провайдер; им же перечитываем состояние после неудачи
const L2_CHANGED_EVENT = 'parvane-l2-changed';

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

export default function useParvaneChatL2(chatId: string | undefined, field: 'isMine' | 'isActive') {
  const [state, setState] = useState<ParvaneChatL2 | undefined>();

  useEffect(() => {
    setState(undefined);
    if (!chatId) return undefined;
    let isCancelled = false;
    const loadState = () => {
      void (callParvane('parvaneGetChatL2', { chatId }) as Promise<ParvaneChatL2 | undefined>)
        .then((next) => {
          if (!isCancelled) setState(next);
        })
        .catch(() => undefined);
    };
    const handleChanged = (event: Event) => {
      if ((event as CustomEvent<{ chatId?: string }>).detail?.chatId === chatId) loadState();
    };
    loadState();
    window.addEventListener(L2_CHANGED_EVENT, handleChanged);
    return () => {
      isCancelled = true;
      window.removeEventListener(L2_CHANGED_EVENT, handleChanged);
    };
  }, [chatId]);

  const toggle = useLastCallback(() => {
    if (!chatId || !state?.isAvailable) return;
    const isEnabled = !state[field];
    setState({ ...state, isActive: isEnabled, [field]: isEnabled });
    void callParvane('parvaneSetChatL2', { chatId, isEnabled })
      .catch(() => false)
      .then((isDone) => {
        if (!isDone) window.dispatchEvent(new CustomEvent(L2_CHANGED_EVENT, { detail: { chatId } }));
      });
  });

  return [state, toggle] as const;
}
