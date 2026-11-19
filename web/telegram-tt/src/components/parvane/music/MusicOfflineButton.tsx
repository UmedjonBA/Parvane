import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  getOfflineState, isTrackSaving, removeOffline, saveTracksOffline,
} from './musicOffline';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OfflineButtonState = 'none' | 'saving' | 'saved';

const LABEL_KEYS = {
  none: 'MusicOfflineSaveTrack',
  saving: 'MusicOfflineSaving',
  saved: 'MusicOfflineSaved',
} as const satisfies Record<OfflineButtonState, string>;

type OwnProps = {
  track: MusicTrack;
  className?: string;
};

// Parvane (spec 041 C3, доски `XpMusic`, `MusicPlayer`, `MusicChat`): один трек на устройство. Значок — состояние:
// стрелка — не загружен, стрелка в круге — на устройстве (нажатие убирает), во время загрузки кнопка выключена
const MusicOfflineButton = ({ track, className }: OwnProps) => {
  const lang = useLang();
  const offline = useDerivedState(getOfflineState);
  const isSaved = offline.entries.some((entry) => entry.track.id === track.id);
  const isSaving = !isSaved && offline.pending > 0 && isTrackSaving(track.id);
  const state = getButtonState(isSaved, isSaving);

  const handleClick = useLastCallback(() => {
    if (isSaved) {
      void removeOffline([track.id]);
      return;
    }
    saveTracksOffline([track]);
  });

  return (
    <button
      type="button"
      className={buildClassName(kit.ib, isSaved && styles.offlineOn, className)}
      aria-label={lang(LABEL_KEYS[state])}
      aria-pressed={isSaved}
      disabled={isSaving}
      data-music-offline-track={state}
      onClick={handleClick}
    >
      <ParvaneIcon name={isSaved ? 'downloaded' : 'download'} isSmall />
    </button>
  );
};

function getButtonState(isSaved: boolean, isSaving: boolean): OfflineButtonState {
  if (isSaved) return 'saved';
  return isSaving ? 'saving' : 'none';
}

export default memo(MusicOfflineButton);
