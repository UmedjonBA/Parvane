import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { MusicInfo, MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { coverTone, splitListTime } from './musicFormat';
import { filterByQuery, sortTracksByArtist } from './musicLibrary';
import { getOfflineState } from './musicOffline';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic } from './musicView';
import useMusicPages from './useMusicPages';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicLoadMore from './MusicLoadMore';
import MusicPlayButtons from './MusicPlayButtons';
import MusicSectionHead from './MusicSectionHead';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

type Sort = 'recent' | 'artist' | 'offline';

const SORTS: Sort[] = ['recent', 'artist', 'offline'];
const SORT_KEYS = {
  recent: 'MusicSortRecentlyAdded', artist: 'MusicSortByArtist', offline: 'MusicSortOnlyDownloaded',
} as const;
const FILTER_FIELDS: (keyof MusicTrack)[] = ['title', 'artist', 'album'];

// Parvane (spec 041, доски `RpMusicA`, `ZdMusicX`): «Любимое» — шапка с числом и временем, «Слушать / Перемешать»,
// поиск по любимому, порядок «Недавно добавленные / По исполнителю / Только загруженные», сердце в строке.
// Список читается страницами по 50 и подгружается при прокрутке
const MusicStarredView = ({ info, isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const offline = useDerivedState(getOfflineState);
  const current = getCurrentTrack(player);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [isSearchOpen, openSearch] = useFlag(!isPhone);
  // Снятые с любимого остаются строкой до ухода с экрана — сердце можно вернуть
  const [unstarred, setUnstarred] = useState<Record<string, boolean>>({});
  const pages = useMusicPages<MusicTrack>('starred', async (offset) => {
    const page = await callMusic('parvaneMusicStarred', { offset });
    return { items: page.tracks, hasMore: page.hasMore };
  });

  const tracks = useMemo(() => {
    const all = (pages.items || []).map((track) => (unstarred[track.id] ? { ...track, isStarred: false } : track));
    const sorted = sort === 'artist' ? sortTracksByArtist(all)
      : sort === 'offline' ? all.filter((track) => offline.entries.some((entry) => entry.track.id === track.id))
        : all;
    return query.trim() ? filterByQuery(sorted, query, FILTER_FIELDS) : sorted;
  }, [pages.items, unstarred, sort, offline, query]);

  const handlePlay = useLastCallback((index: number) => {
    playTracks(tracks, index, { source: { kind: 'starred' } });
  });
  const handlePlayAll = useLastCallback(() => handlePlay(0));
  const handleShuffle = useLastCallback(() => {
    playTracks(tracks, 0, { isShuffled: true, source: { kind: 'starred' } });
  });

  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    setUnstarred((previous) => ({ ...previous, [track.id]: !isStarred }));
    void setTrackStarred(track, isStarred);
  });

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value));
  const handleSort = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setSort(e.currentTarget.dataset.sort as Sort);
  });

  const count = info.starredCount || pages.items?.length || 0;
  const time = splitListTime((pages.items || []).reduce((sum, track) => sum + track.durationSecs, 0));
  const subtitle = [
    lang('MusicTracksCount', { count }, { pluralValue: count }),
    !pages.hasMore && lang('MusicListTime', { hours: time.hours, minutes: time.minutes }),
  ].filter(Boolean).join(' · ');

  const search = isSearchOpen && (
    <input
      className={buildClassName(kit.input, styles.headSearch)}
      type="search"
      value={query}
      placeholder={lang('MusicFindInStarred')}
      aria-label={lang('MusicFindInStarred')}
      onChange={handleQuery}
    />
  );
  const chips = isPhone && (
    <div className={kit.chips} role="group" aria-label={lang('MusicSortLabel')}>
      {SORTS.map((value) => (
        <button
          key={value}
          type="button"
          className={buildClassName(kit.chip, sort === value && kit.chipOn)}
          aria-pressed={sort === value}
          data-sort={value}
          onClick={handleSort}
        >
          {lang(SORT_KEYS[value])}
        </button>
      ))}
    </div>
  );

  return (
    <div className={styles.view}>
      <MusicSectionHead
        title={lang('MusicStarred')}
        tone={coverTone('starred')}
        cover={<MusicCover toneId="starred" size={150} glyph="heart" isLarge />}
        subtitle={subtitle}
        isCoverAside
        isPhone={isPhone}
        barActions={!isSearchOpen && (
          <button type="button" className={kit.ib} aria-label={lang('MusicFindInStarred')} onClick={openSearch}>
            <ParvaneIcon name="search" />
          </button>
        )}
        tools={(
          <>
            {search}
            {chips}
          </>
        )}
        actions={(
          <MusicPlayButtons
            playKey={isPhone ? 'MusicPlayAll' : 'MusicListen'}
            shuffleKey={isPhone ? 'MusicShufflePlay' : 'MusicShuffleMix'}
            isDisabled={!tracks.length}
            onPlay={handlePlayAll}
            onShuffle={handleShuffle}
          />
        )}
        onBack={goBackMusic}
      />
      {pages.isFailed && <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>}
      {!pages.isLoaded && <PvSkeleton />}
      {pages.isLoaded && !pages.items?.length && <PvEmpty text={lang('MusicStarredEmpty')} data-music-empty />}
      {Boolean(tracks.length) && (
        <ul className={styles.tracks} data-music-tracks>
          {tracks.map((track, index) => (
            <MusicTrackRow
              key={track.id}
              track={track}
              index={index}
              isCurrent={track.id === current?.id}
              isPlaying={player.isPlaying}
              columns={isPhone ? undefined : ['artist']}
              trailing={isPhone && track.isStarred ? 'unstar' : undefined}
              canQueue
              canSaveOffline
              onPlay={handlePlay}
              onStar={handleStar}
              onSendToChat={onSendToChat}
            />
          ))}
        </ul>
      )}
      {pages.hasMore && <MusicLoadMore onMore={pages.loadMore} />}
      {Boolean(pages.items?.length) && (
        <div className={buildClassName(kit.muted, kit.small)} data-music-starred-note>
          {isPhone ? lang('MusicStarredNotePhone', { count }, { pluralValue: count }) : lang('MusicStarredNote')}
        </div>
      )}
    </div>
  );
};

export default memo(MusicStarredView);
