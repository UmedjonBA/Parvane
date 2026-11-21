import { memo, useEffect } from '../../../lib/teact/teact';

import type { MusicInfo, MusicTrack } from '../../../api/parvane/musicApi';

import { deleteLibraryTrack, MUSIC_LIBRARY_CHANGED_EVENT } from './musicAdded';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks,
} from './musicPlayer';
import { goBackMusic } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicSectionHead from './MusicSectionHead';
import { formatMusicSize } from './MusicSize';
import MusicTrackRow from './MusicTrackRow';

import styles from './Music.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

// Parvane (spec 039 этап B, 041): «Добавлено мной» — функция сверх макета: своё, добавленное через «Найти и
// скачать», с расходом лимита и места и удалением из библиотеки сервера. Шапка — общая шапка раздела
const MusicAddedView = ({ info, isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const { data, isFailed, reload } = useMusicData('added', async () => {
    const added = await callMusic('parvaneMusicAdded', { isMine: true });
    return added.filter((item) => item.track.id);
  });

  useEffect(() => {
    window.addEventListener(MUSIC_LIBRARY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MUSIC_LIBRARY_CHANGED_EVENT, reload);
  }, [reload]);

  const handlePlay = useLastCallback((index: number) => {
    playTracks(data!.map((item) => item.track), index, { source: { kind: 'home' } });
  });
  const handleDelete = useLastCallback((track: MusicTrack) => void deleteLibraryTrack(track.id));

  return (
    <div className={styles.view}>
      <MusicSectionHead
        title={lang('MusicAdded')}
        subtitle={(
          <span data-music-usage>
            {lang('MusicAddedUsage', {
              today: info.addedToday,
              perDay: info.addPerDay,
              used: formatMusicSize(lang, info.usedBytes),
              quota: formatMusicSize(lang, info.quotaBytes),
            })}
          </span>
        )}
        isPhone={isPhone}
        onBack={goBackMusic}
      />
      {isFailed && <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>}
      {!data && !isFailed && <PvSkeleton />}
      {data && !data.length && <PvEmpty text={lang('MusicAddedEmpty')} data-music-empty />}
      {Boolean(data?.length) && (
        <ul className={styles.tracks} data-music-added="mine">
          {data.map((item, index) => (
            <MusicTrackRow
              key={item.track.id}
              track={item.track}
              index={index}
              isCurrent={item.track.id === current?.id}
              isPlaying={player.isPlaying}
              canQueue
              canSaveOffline
              onPlay={handlePlay}
              onSendToChat={onSendToChat}
              onDelete={handleDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

export default memo(MusicAddedView);
