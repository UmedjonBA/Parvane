import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicInfo, MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { deleteLibraryTrack, MUSIC_LIBRARY_CHANGED_EVENT } from './musicAdded';
import { openMusicFileSheet } from './musicFiles';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks,
} from './musicPlayer';
import { goBackMusic } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import ConfirmDialog from '../../ui/ConfirmDialog';
import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicPlaylistPicker from './MusicPlaylistPicker';
import MusicSectionHead from './MusicSectionHead';
import { formatMusicSize } from './MusicSize';
import MusicTrackRow from './MusicTrackRow';

import styles from './Music.module.scss';
import select from './MusicSelect.module.scss';

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

  // Выбор нескольких (доски `MusicLibrary-07/08`, `RdMusic-02`): правка, «В плейлист», «В корзину»
  const { showNotification } = getActions();
  const [selected, setSelected] = useState<Set<string>>();
  const [isConfirming, setIsConfirming] = useState(false);
  const [pickerTracks, setPickerTracks] = useState<MusicTrack[]>();
  const tracks = (data || []).map((item) => item.track);
  const chosen = selected ? tracks.filter((track) => selected.has(track.id)) : [];
  const copies = tracks.filter((track) => track.isCopy);

  const handleStartSelect = useLastCallback(() => setSelected(new Set()));
  const handleStopSelect = useLastCallback(() => setSelected(undefined));
  const handleToggle = useLastCallback((index: number) => {
    const id = tracks[index]?.id;
    if (!id) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  });
  const handleEditSelected = useLastCallback(() => openMusicFileSheet({ kind: 'tracks', tracks: chosen }));
  const handlePlaylistSelected = useLastCallback(() => setPickerTracks(chosen));
  const handleClosePicker = useLastCallback(() => setPickerTracks(undefined));
  const handleAskDelete = useLastCallback(() => setIsConfirming(true));
  const handleCancelDelete = useLastCallback(() => setIsConfirming(false));
  const handleConfirmDelete = useLastCallback(async () => {
    setIsConfirming(false);
    const results = await Promise.all(chosen.map((track) => deleteLibraryTrack(track.id)));
    const done = results.filter(Boolean).length;
    showNotification({ message: lang('MusicMovedToTrashN', { count: done }, { pluralValue: done }) });
    setSelected(undefined);
  });
  // «Оставить один»: копии той же версии — в корзину
  const handleKeepOne = useLastCallback(async () => {
    const results = await Promise.all(copies.map((track) => deleteLibraryTrack(track.id)));
    const done = results.filter(Boolean).length;
    showNotification({ message: lang('MusicMovedToTrashN', { count: done }, { pluralValue: done }) });
  });

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
        barActions={Boolean(tracks.length) && !selected && (
          <button type="button" className={select.textButton} data-music-select-start onClick={handleStartSelect}>
            {lang('MusicSelect')}
          </button>
        )}
        actions={!isPhone && Boolean(tracks.length) && !selected && (
          <button type="button" className={select.textButton} data-music-select-start onClick={handleStartSelect}>
            {lang('MusicSelect')}
          </button>
        )}
        onBack={goBackMusic}
      />
      {selected && (
        <div className={select.bar} data-music-selection={selected.size}>
          <button type="button" className={select.icon} aria-label={lang('Cancel')} onClick={handleStopSelect}>
            <ParvaneIcon name="close" />
          </button>
          <span className={select.count}>{lang('MusicSelected', { count: selected.size })}</span>
          <button
            type="button"
            className={select.icon}
            aria-label={lang('MusicEditTags')}
            disabled={!selected.size}
            data-music-selection-edit
            onClick={handleEditSelected}
          >
            <ParvaneIcon name="pen" />
          </button>
          <button
            type="button"
            className={select.icon}
            aria-label={lang('MusicToPlaylist')}
            disabled={!selected.size}
            onClick={handlePlaylistSelected}
          >
            <ParvaneIcon name="plus" />
          </button>
          <button
            type="button"
            className={buildClassName(select.icon, select.danger)}
            aria-label={lang('MusicToTrash')}
            disabled={!selected.size}
            data-music-selection-delete
            onClick={handleAskDelete}
          >
            <ParvaneIcon name="trash" />
          </button>
        </div>
      )}
      {Boolean(copies.length) && (
        <div className={select.banner} data-music-copies={copies.length}>
          <ParvaneIcon name="copy" isSmall />
          <span className={select.bannerText}>
            {lang('MusicDownloadedTwice', { name: copies[0].title })}
          </span>
          <button type="button" className={select.bannerButton} onClick={handleKeepOne}>{lang('MusicKeepOne')}</button>
        </div>
      )}
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
              isSelected={selected?.has(item.track.id)}
              isSelecting={Boolean(selected)}
              canQueue
              canSaveOffline
              onPlay={selected ? handleToggle : handlePlay}
              onSendToChat={onSendToChat}
              onDelete={handleDelete}
            />
          ))}
        </ul>
      )}
      {pickerTracks && <MusicPlaylistPicker tracks={pickerTracks} onClose={handleClosePicker} />}
      <ConfirmDialog
        isOpen={isConfirming}
        title={lang('MusicDeleteTitle', { count: chosen.length }, { pluralValue: chosen.length })}
        text={lang('MusicDeleteText')}
        confirmLabel={lang('MusicToTrash')}
        confirmIsDestructive
        confirmHandler={handleConfirmDelete}
        onClose={handleCancelDelete}
      />
    </div>
  );
};

export default memo(MusicAddedView);
