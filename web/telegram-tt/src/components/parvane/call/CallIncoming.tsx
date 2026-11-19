import { memo } from '../../../lib/teact/teact';

import { getCallInitial } from './callTypes';

import useOldLang from '../../../hooks/useOldLang';

import CallButton from './CallButton';

import styles from './Call.module.scss';

type OwnProps = {
  peerName: string;
  status: string;
  onAccept: NoneToVoidFunction;
  onDecline: NoneToVoidFunction;
};

// Входящий звонок (доска `RpCalls`): кто звонит и две кнопки с подписями
const CallIncoming = ({
  peerName, status, onAccept, onDecline,
}: OwnProps) => {
  const lang = useOldLang();

  return (
    <div className={styles.incoming}>
      <div className={styles.note}>{lang('ParvaneCallIncomingTitle')}</div>
      <div className={styles.avatarLarge} aria-hidden>{getCallInitial(peerName)}</div>
      <div className={styles.nameLarge}>{peerName}</div>
      <div className={styles.status}>{status}</div>
      <div className={styles.spacer} />
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
