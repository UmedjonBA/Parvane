import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { RegularLangKey } from '../../../types/language';

import buildClassName from '../../../util/buildClassName';
import { getSendFailures, sendFailureKey } from '../../../util/parvaneSendFailures';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './MessageSendFailed.module.scss';

type OwnProps = {
  chatId: string;
  messageId: number;
};

const ROW_REASON_KEYS: Partial<Record<RegularLangKey, RegularLangKey>> = {
  ParvaneFederationUnreachable: 'MessageSendFailedUnreachable',
};

// Служебная строка под неотправленным сообщением (доска `ZpChat`): причина и «Отменить отправку»
const MessageSendFailed = ({ chatId, messageId }: OwnProps) => {
  const { deleteMessages } = getActions();
  const lang = useLang();
  const failures = useDerivedState(getSendFailures);
  const reasonKey = failures[sendFailureKey(chatId, messageId)] as RegularLangKey | undefined;

  // Причина после двоеточия — со строчной; у недоступного сервера — своя фраза доски «Отправим сами, когда он ответит»
  function getReasonText(key: RegularLangKey) {
    const rowKey = ROW_REASON_KEYS[key];
    if (rowKey) return lang(rowKey);
    const text = lang(key);
    return text.charAt(0).toLocaleLowerCase(lang.code) + text.slice(1);
  }

  const handleCancel = useLastCallback(() => {
    deleteMessages({ messageIds: [messageId] });
  });

  return (
    <div className={styles.root} data-message-send-failed>
      <span className={styles.text}>
        {reasonKey ? lang('MessageSendFailedReason', { reason: getReasonText(reasonKey) }) : lang('MessageSendFailed')}
      </span>
      <button type="button" className={buildClassName(kit.chip, styles.cancel)} onClick={handleCancel}>
        {lang('MessageSendCancel')}
      </button>
    </div>
  );
};

export default memo(MessageSendFailed);
