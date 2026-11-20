import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { getCallInitial } from './callTypes';

import useLang from '../../../hooks/useLang';

import kit from '../notes/PvKit.module.scss';
import styles from './Call.module.scss';

type OwnProps = {
  fromName: string;
  title?: string;
  onAccept: NoneToVoidFunction;
  onDecline: NoneToVoidFunction;
};

// Приглашение в другой звонок во время разговора (доска `DkCalls`): карточка поверх звонка. «Принять» завершает
// текущий разговор
const CallWaitingInvite = ({
  fromName, title, onAccept, onDecline,
}: OwnProps) => {
  const lang = useLang();
  return (
    <div className={styles.waiting} role="alertdialog" aria-label={lang('ParvaneCallWaitingLabel')}>
      <div className={styles.waitingHead}>
        <span className={styles.inviteAvatar} aria-hidden>{getCallInitial(fromName)}</span>
        <div className={styles.waitingText}>
          <div className={styles.waitingName}>{fromName}</div>
          <div className={styles.note}>
            {title ? lang('ParvaneCallWaitingNamed', { title }) : lang('ParvaneCallWaitingGroup')}
          </div>
        </div>
      </div>
      <div className={styles.waitingButtons}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnGhost, kit.btnDanger, styles.waitingButton)}
          onClick={onDecline}
        >
          {lang('ParvaneCallWaitingDecline')}
        </button>
        <button type="button" className={buildClassName(kit.btn, kit.btnAcc, styles.waitingButton)} onClick={onAccept}>
          {lang('ParvaneCallWaitingAccept')}
        </button>
      </div>
    </div>
  );
};

export default memo(CallWaitingInvite);
