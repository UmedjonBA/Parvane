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

// Служебная строка под неотправленным сообщением (доска `ZpChat`): причина и «Отменить отправку»
const MessageSendFailed = ({ chatId, messageId }: OwnProps) => {
  const { deleteMessages } = getActions();
  const lang = useLang();
  const failures = useDerivedState(getSendFailures);
  const reasonKey = failures[sendFailureKey(chatId, messageId)] as RegularLangKey | undefined;

  const handleCancel = useLastCallback(() => {
    deleteMessages({ messageIds: [messageId] });
  });

  return (
    <div className={styles.root} data-message-send-failed>
      <span className={styles.text}>
        {reasonKey ? lang('MessageSendFailedReason', { reason: lang(reasonKey) }) : lang('MessageSendFailed')}
      </span>
      <button type="button" className={buildClassName(kit.chip, styles.cancel)} onClick={handleCancel}>
        {lang('MessageSendCancel')}
      </button>
    </div>
  );
};

export default memo(MessageSendFailed);
