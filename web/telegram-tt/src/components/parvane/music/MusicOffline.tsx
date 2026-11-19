import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { splitBytes } from './musicFormat';
import {
  getOfflineBytes, getOfflineState, OFFLINE_LIMIT_BYTES, removeOffline,
} from './musicOffline';
import { playTracks } from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  currentTrackId?: string;
  isPlaying?: boolean;
};

// Parvane (spec 041 C3): «Загруженное» — треки на этом устройстве, играют без сети
const MusicOffline = ({ currentTrackId, isPlaying }: OwnProps) => {
  const lang = useLang();
  const state = useDerivedState(getOfflineState);
  const [isClearAsked, askClear, cancelClear] = useFlag();

  const handlePlay = useLastCallback((index: number) => {
    playTracks(state.entries.map((entry) => entry.track), index);
  });

  const handleRemove = useLastCallback((index: number) => {
    void removeOffline([state.entries[index].track.id]);
  });

  const handleClear = useLastCallback(() => {
    cancelClear();
    void removeOffline();
  });

  function renderSize(bytes: number) {
    const size = splitBytes(bytes);
    const digits = size.isGigabytes ? 1 : 0;
    const value = new Intl.NumberFormat(lang.code, { maximumFractionDigits: digits }).format(size.value);
    return lang(size.isGigabytes ? 'MusicSizeGb' : 'MusicSizeMb', { value });
  }

  const count = state.entries.length;
  return (
    <div className={styles.playlist} data-music-offline={count}>
      <div className={styles.listHead}>
        <span className={buildClassName(kit.muted, kit.grow)} data-offline-usage>
          {lang('MusicOfflineUsage', {
            count, used: renderSize(getOfflineBytes(state)), limit: renderSize(OFFLINE_LIMIT_BYTES),
          }, { pluralValue: count })}
        </span>
        {Boolean(count) && (
          <button
            type="button"
            className={buildClassName(kit.btn, isClearAsked && kit.btnDanger)}
            data-offline-clear={isClearAsked ? 'confirm' : 'ask'}
            onClick={isClearAsked ? handleClear : askClear}
          >
            {lang(isClearAsked ? 'MusicOfflineClearConfirm' : 'MusicOfflineClear')}
          </button>
        )}
      </div>
      {Boolean(state.pending) && (
        <div className={kit.muted} role="status" data-offline-progress>
          {lang('MusicOfflineProgress', { done: state.total - state.pending, total: state.total })}
        </div>
      )}
      {state.problem && (
        <div className={styles.error} role="alert" data-offline-problem={state.problem}>
          {lang(state.problem === 'limit' ? 'MusicOfflineLimit' : 'MusicOfflineFailed')}
        </div>
      )}
      {!count && !state.pending && <PvEmpty text={lang('MusicOfflineEmpty')} data-music-empty />}
      {Boolean(count) && (
        <ul className={styles.tracks} data-music-tracks>
          {state.entries.map((entry, index) => (
            <MusicTrackRow
              key={entry.track.id}
              track={entry.track}
              index={index}
              isCurrent={entry.track.id === currentTrackId}
              isPlaying={isPlaying}
              canQueue
              canRemove
              removeLabel={lang('MusicOfflineRemove', { name: entry.track.title })}
              onPlay={handlePlay}
              onRemove={handleRemove}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

export default memo(MusicOffline);
