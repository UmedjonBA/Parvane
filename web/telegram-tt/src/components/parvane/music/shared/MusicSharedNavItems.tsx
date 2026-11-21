import { memo, useEffect } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';
import { openMusicView } from '../musicView';
import { getSharedPlaylists, watchSharedPlaylists } from './musicShared';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLastCallback from '../../../../hooks/useLastCallback';

import ParvaneIcon from '../../../main/ParvaneIcon';

import kit from '../../notes/PvKit.module.scss';
import musicStyles from '../Music.module.scss';

type OwnProps = {
  // Открытый общий плейлист — подсвечен
  selectedId?: string;
};

// Parvane (spec 041, доска `DeskMusic`): общие плейлисты в группе «Плейлисты» навигации компьютера — после своих,
// с числом треков («Linux-чат: общее 97»)
const MusicSharedNavItems = ({ selectedId }: OwnProps) => {
  const shared = useDerivedState(getSharedPlaylists);

  useEffect(() => watchSharedPlaylists(), []);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'shared', id: e.currentTarget.dataset.shared! }, true);
  });

  return (
    <>
      {shared.map((playlist) => {
        const isOn = playlist.id === selectedId;
        return (
          <button
            key={playlist.id}
            type="button"
            className={buildClassName(musicStyles.navItem, isOn && musicStyles.navItemOn)}
            aria-current={isOn ? 'page' : undefined}
            data-shared={playlist.id}
            data-shared-invited={playlist.isInvited || undefined}
            onClick={handleOpen}
          >
            <ParvaneIcon name="users" isSmall />
            <span className={musicStyles.navLabel}>{playlist.name}</span>
            <span className={buildClassName(kit.mono, kit.muted, musicStyles.navCount)}>{playlist.trackCount}</span>
          </button>
        );
      })}
    </>
  );
};

export default memo(MusicSharedNavItems);
