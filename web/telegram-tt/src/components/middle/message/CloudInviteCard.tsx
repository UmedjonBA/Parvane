import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import type { ApiCloudInviteCard } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { openFiles } from '../../../util/parvaneSection';
import {
  answerCloudInvite, getCloudData, getContainer, loadCloud, setCloudPlace,
} from '../../parvane/cloud/cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import PvModuleOff from '../../parvane/notes/PvModuleOff';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './CloudInviteCard.module.scss';

type OwnProps = {
  invite: ApiCloudInviteCard;
  isOwn?: boolean;
};

// Parvane (CLOUD-1): приглашение в совместную папку «Файлов» в чате — карточка вместо текста (доски `RpFiles`,
// `ZpChat`). Ответ — здесь же; принятая папка открывается в «Файлах». Своё приглашение только показывается
const CloudInviteCard = ({ invite, isOwn }: OwnProps) => {
  const lang = useLang();
  const gate = useModuleGate('files');
  const [isAnswering, setIsAnswering] = useState(false);
  const data = useDerivedState(getCloudData);
  const container = getContainer(invite.containerId, data);
  const isPending = container?.kind === 'invite';
  const isJoined = Boolean(container) && !isPending;
  const isFilesOn = gate.isOn;

  // Ответить можно, когда облако знает приглашение: карточка сама подгружает его состояние
  useEffect(() => {
    if (isFilesOn && !isOwn) void loadCloud(getGlobal().currentUserId);
  }, [isFilesOn, isOwn]);

  const answer = useLastCallback(async (isAccepted: boolean) => {
    setIsAnswering(true);
    try {
      await answerCloudInvite(invite.containerId, isAccepted);
    } finally {
      setIsAnswering(false);
    }
  });
  const handleAccept = useLastCallback(() => gate.run(() => void answer(true)));
  const handleDecline = useLastCallback(() => void answer(false));
  const handleOpen = useLastCallback(() => gate.run(() => {
    if (isJoined) setCloudPlace({ view: 'shared', container: invite.containerId });
    openFiles();
  }));

  if (!isFilesOn && !gate.canEnable) {
    return <div className={styles.text}>{invite.text}</div>;
  }

  return (
    <div className={styles.root} data-cloud-invite={invite.name}>
      <div className={styles.label}>
        {lang('CloudInviteLabel')}
        {' · '}
        {lang(invite.isEditor ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader')}
      </div>
      <div className={styles.title}>{invite.name || lang('ParvaneCloudSharedFolder')}</div>
      <div className={styles.hint}>
        {lang(invite.isEditor ? 'ParvaneCloudRoleEditorHint' : 'ParvaneCloudRoleReaderHint')}
      </div>
      {isPending && !isOwn ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc, styles.action)}
            disabled={isAnswering}
            onClick={handleAccept}
          >
            {lang('ParvaneCloudAccept')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.btn, styles.action)}
            disabled={isAnswering}
            onClick={handleDecline}
          >
            {lang('ParvaneCloudDecline')}
          </button>
        </div>
      ) : (
        <button type="button" className={buildClassName(kit.chip, styles.open)} onClick={handleOpen}>
          {lang(isJoined ? 'CloudInviteOpen' : 'CloudInviteOpenFiles')}
        </button>
      )}
      <PvModuleOff
        isOpen={gate.isAsked}
        module="files"
        hint={lang('ModuleOffHintCloudInvite')}
        onEnable={gate.enable}
        onClose={gate.dismiss}
      />
    </div>
  );
};

export default memo(CloudInviteCard);
