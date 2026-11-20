import {
  memo, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { sendCloudFileCopy } from './cloudCopies';
import { addressOfNick } from './cloudModel';
import { getCloudData } from './cloudStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './CloudSheets.module.scss';

type OwnProps = {
  // Чей файл отдать копией; не задано — окно закрыто
  entry?: { container: string; node: CloudNode };
  onClose: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const USER_CHAT_TYPES = ['users'] as const;

// Parvane (spec 041, CLOUD-3; доска `ZdFilesX` «Доступ собеседникам…»): одиночный файл отдаётся КОПИЕЙ —
// собеседник получает её в «Файлы → Доступные мне», у владельца файл остаётся на месте, правки дальше расходятся.
// Копия уходит сообщением-файлом в личный чат (как «Отправить в чат») с пометкой «в „Файлы“».
const CloudShareCopyDialog = ({ entry, onClose }: OwnProps) => {
  const lang = useLang();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [isPickerOpen, openPicker, closePicker] = useFlag();
  const [hasNick, setHasNick] = useState(false);
  const [nickError, setNickError] = useState<string>();
  const nickRef = useRef<HTMLInputElement>();
  const isOpen = Boolean(entry);

  // Поле готовится к вводу в кадре появления окна
  useLayoutEffect(() => {
    if (!isOpen) return;
    setHasNick(false);
    setNickError(undefined);
    if (nickRef.current) nickRef.current.value = '';
  }, [isOpen]);

  const send = async (chatId: string) => {
    if (!entry) return false;
    markBusy();
    const isSent = await sendCloudFileCopy(entry.container, entry.node.id, chatId);
    unmarkBusy();
    if (isSent) onClose();
    return isSent;
  };

  const handlePick = useLastCallback((chatId: string) => {
    closePicker();
    void send(chatId);
  });

  const handleNickInput = useLastCallback((e: React.FormEvent<HTMLInputElement>) => {
    setHasNick(Boolean(e.currentTarget.value.trim()));
    setNickError(undefined);
  });

  const handleSubmit = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = nickRef.current?.value || '';
    if (!text.trim()) {
      openPicker();
      return;
    }
    const selfDomain = getCloudData()?.containers.find((c) => c.kind === 'root')?.owner.split('@')[1];
    const user = addressOfNick(text, selfDomain);
    if (!user) {
      setNickError(lang('ParvaneCloudNickInvalid'));
      return;
    }
    markBusy();
    const chatId = await callParvane('parvaneResolveExactAddress', { address: user })
      .catch(() => undefined) as string | undefined;
    unmarkBusy();
    if (!chatId) {
      setNickError(lang('ParvaneCloudNickNotFound'));
      return;
    }
    if (!await send(chatId)) setNickError(lang('ParvaneCloudErrorRejected'));
  });

  return (
    <>
      <PvSheet
        isOpen={isOpen && !isPickerOpen}
        title={entry ? lang('ParvaneCloudShareCopyTitle', { name: entry.node.name }) : undefined}
        className={styles.narrow}
        onClose={onClose}
      >
        <form className={styles.shareNick} onSubmit={handleSubmit} data-share-copy>
          <label className={styles.field}>
            {lang('ParvaneCloudNickLabel')}
            <span className={styles.shareNickRow}>
              <input
                ref={nickRef}
                className={buildClassName(kit.input, styles.shareNickInput)}
                placeholder="@nick"
                aria-label={lang('ParvaneCloudNickLabel')}
                aria-invalid={Boolean(nickError)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="send"
                onInput={handleNickInput}
              />
              <button type="submit" className={kit.btn} disabled={isBusy} data-share-copy-submit>
                {lang(hasNick ? 'ParvaneCloudShareCopySend' : 'ParvaneCloudFromContacts')}
              </button>
            </span>
          </label>
          {nickError && <div className={kit.fieldError} role="alert">{nickError}</div>}
        </form>
        <div className={styles.note}>{lang('ParvaneCloudShareCopyNote')}</div>
        <div className={styles.buttons}>
          <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>
        </div>
      </PvSheet>
      <RecipientPicker
        isOpen={isOpen && isPickerOpen}
        title={lang('ParvaneCloudShareCopy')}
        searchPlaceholder={lang('Search')}
        filter={USER_CHAT_TYPES}
        onSelectRecipient={handlePick}
        onClose={closePicker}
      />
    </>
  );
};

export default memo(CloudShareCopyDialog);
