import { useEffect, useState } from '../../../../lib/teact/teact';

import { callApi } from '../../../../api/gramjs';

import useLastCallback from '../../../../hooks/useLastCallback';

export type TelegramRecoveryState = 'idle' | 'unavailable' | 'waiting' | 'joining' | 'done' | 'failed' | 'limit'
  | 'expired' | 'intercepted' | 'bundle_off';

export type LinkStatus = {
  isPending: boolean;
  code?: string;
  canRecover?: boolean;
  hasEscrow?: boolean;
  telegram?: TelegramRecoveryState;
  telegramCode?: string;
};

export type LinkOffer = { deviceId: string; code?: string };

// Ключ подписи устройств (T128, D-12): отозвано устройство, державшее его, — ключ обновляется корнем (`hasRoot` —
// корень на устройстве, RECOVER-1 п. 8; иначе — из копии под ключом восстановления)
export type SskState = {
  isRotationNeeded: boolean; hasBackup: boolean; hasRoot?: boolean; isEscrowCopyMissing?: boolean;
  canSendKeyToTelegram?: boolean;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const LINK_UI_POLL_MS = 5000;

/**
 * Состояние привязки устройств для экрана «Устройства» (LINK-1, RECOVER-2): свой запрос привязки и вход по ключу
 * либо через Telegram, запросы других своих устройств, ключ подписи, вышедшие сами устройства. Опрашивается, пока
 * экран открыт; логика — в провайдере, здесь только чтение.
 */
export default function useDeviceLink(isActive?: boolean) {
  const [linkStatus, setLinkStatus] = useState<LinkStatus | undefined>();
  const [linkOffers, setLinkOffers] = useState<LinkOffer[]>([]);
  const [sskState, setSskState] = useState<SskState | undefined>();
  // ENG-04: вышедшие сами устройства, державшие ключ подписи устройств
  const [leftDevices, setLeftDevices] = useState<string[]>([]);

  const refresh = useLastCallback(async () => {
    setLinkStatus(await callParvane('parvaneGetLinkStatus') as LinkStatus | undefined);
    const offers = await callParvane('parvaneListLinkOffers') as { offers: LinkOffer[] } | undefined;
    setLinkOffers(offers?.offers || []);
    setSskState(await callParvane('parvaneGetSskState') as SskState | undefined);
    const left = await callParvane('parvaneGetLeftDevices') as { deviceIds: string[] } | undefined;
    setLeftDevices(left?.deviceIds || []);
    // Другое устройство могло выйти само — список перечитается по событию провайдера
    void callParvane('parvanePollOwnDevices');
  });

  useEffect(() => {
    if (!isActive) return undefined;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, LINK_UI_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isActive, refresh]);

  return {
    linkStatus, linkOffers, sskState, leftDevices, refresh,
  };
}
