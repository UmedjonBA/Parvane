import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { getCallInitial } from './callTypes';

import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import CallButton from './CallButton';

import kit from '../notes/PvKit.module.scss';
import styles from './Call.module.scss';

type OwnProps = {
  peerName: string;
  status: string;
  // Личный вызов: «звонит вам…» только для чтения с экрана (доска `RpCalls`), у группового приглашения — видно
  isStatusHidden?: boolean;
  // `@ник` звонящего и «в контактах» (личный звонок)
  handle?: string;
  isContact?: boolean;
  onAccept: NoneToVoidFunction;
  onDecline: NoneToVoidFunction;
  // Отклонить и открыть чат со звонящим; нет чата — кнопки нет
  onReplyWithMessage?: NoneToVoidFunction;
};

// Входящий звонок (доска `RpCalls`): кто звонит, «Ответить сообщением» и две кнопки с подписями
const CallIncoming = ({
  peerName, status, isStatusHidden, handle, isContact, onAccept, onDecline, onReplyWithMessage,
}: OwnProps) => {
  const lang = useOldLang();
  const langNew = useLang();

  return (
    <div className={styles.incoming}>
      <div className={styles.note}>{lang('ParvaneCallIncomingTitle')}</div>
      <div className={styles.avatarLarge} aria-hidden>{getCallInitial(peerName)}</div>
      <div className={styles.nameLarge}>{peerName}</div>
      {handle && (
        <div className={styles.handle} data-call-handle>
          {isContact ? langNew('ParvaneCallHandleContact', { handle }) : handle}
        </div>
      )}
      <div className={isStatusHidden ? styles.readerOnly : styles.status}>{status}</div>
      <div className={styles.spacer} />
      {onReplyWithMessage && (
        <button type="button" className={buildClassName(kit.chip, styles.replyChip)} onClick={onReplyWithMessage}>
          {langNew('ParvaneCallReplyWithMessage')}
        </button>
      )}
      <div className={styles.answer}>
        <CallButton
          icon="icon-phone-discard"
          kind="hangup"
          isLarge
          label={lang('CallEndCall')}
          caption={lang('ParvaneCallDecline')}
          onClick={onDecline}
        />
        <CallButton
          icon="icon-phone"
          kind="accept"
          isLarge
          label={lang('CallAccept')}
          caption={lang('ParvaneCallAnswer')}
          onClick={onAccept}
        />
      </div>
    </div>
  );
};

export default memo(CallIncoming);
