import { memo } from '../../../lib/teact/teact';

import { getCallInitial } from './callTypes';

import useLang from '../../../hooks/useLang';

import styles from './Call.module.scss';

export type CallCandidate = { address: string; name: string };

type OwnProps = {
  // `undefined` — список ещё грузится
  candidates?: CallCandidate[];
  onChoose: (address: string) => void;
  onClose: NoneToVoidFunction;
};

// «Позвать участника» (доски `PhCalls`, `DkCalls`): участники группы, которых нет в звонке
const CallInvitePicker = ({ candidates, onChoose, onClose }: OwnProps) => {
  const lang = useLang();
  return (
    <div className={styles.outputList} role="group" aria-label={lang('ParvaneCallInvite')} data-call-invite-list>
      <div className={styles.outputHeader}>
        {lang('ParvaneCallInvite')}
        <button type="button" className={styles.outputClose} aria-label={lang('Close')} onClick={onClose}>
          <i className="icon icon-close" aria-hidden />
        </button>
      </div>
      {candidates && !candidates.length && (
        <div className={styles.inviteEmpty}>{lang('ParvaneCallInviteEmpty')}</div>
      )}
      {candidates?.map(({ address, name }) => (
        <button
          key={address}
          type="button"
          className={styles.inviteOption}
          onClick={() => onChoose(address)}
        >
          <span className={styles.inviteAvatar} aria-hidden>{getCallInitial(name)}</span>
          {name}
        </button>
      ))}
    </div>
  );
};

export default memo(CallInvitePicker);
