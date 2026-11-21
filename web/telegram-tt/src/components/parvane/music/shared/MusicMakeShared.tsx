import { memo, useLayoutEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { MusicPlaylist } from '../../../../api/parvane/musicApi';
import type { MusicSharedAccess } from '../../../../api/parvane/musicSharedApi';

import buildClassName from '../../../../util/buildClassName';
import { openMusicView } from '../musicView';
import { makePlaylistShared } from './musicShared';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import PvSheet from '../../notes/PvSheet';
import MusicAccessPicker from './MusicAccessPicker';

import kit from '../../notes/PvKit.module.scss';
import styles from './MusicShared.module.scss';

type OwnProps = {
  isOpen: boolean;
  playlist: MusicPlaylist;
  onClose: NoneToVoidFunction;
};

// Parvane (spec 041, доска `DeskMusicMore`): «Сделать общим» из меню личного плейлиста — «Кто видит»
// («Выбранные люди» / «Все на сервере»), затем общий плейлист с теми же треками; личный удаляется
const MusicMakeShared = ({ isOpen, playlist, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [access, setAccess] = useState<MusicSharedAccess>('members');
  const [isBusy, setIsBusy] = useState(false);

  useLayoutEffect(() => {
    if (isOpen) setAccess('members');
  }, [isOpen]);

  const handleAccess = useLastCallback((value: string) => setAccess(value === 'server' ? 'server' : 'members'));

  const handleConfirm = useLastCallback(async () => {
    if (isBusy) return;
    setIsBusy(true);
    const shared = await makePlaylistShared(playlist, access);
    setIsBusy(false);
    onClose();
    if (!shared) {
      showNotification({ message: lang('MusicSharedActionFailed') });
      return;
    }
    openMusicView({ kind: 'shared', id: shared.id });
  });

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('MusicMakeSharedTitle', { name: playlist.name })}
      onClose={onClose}
      onEnter={handleConfirm}
    >
      <div className={styles.form} data-music-make-shared-sheet>
        <MusicAccessPicker value={access} noPersonal onChange={handleAccess} />
        <div className={styles.buttons}>
          <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={isBusy}
            onClick={handleConfirm}
          >
            {lang('MusicMakeShared')}
          </button>
        </div>
      </div>
    </PvSheet>
  );
};

export default memo(MusicMakeShared);
