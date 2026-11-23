import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  addTracksToShared, canEditTracks, getSharedPlaylists, refreshSharedPlaylists, toTrackInput,
} from './shared/musicShared';
import { addTracksToPlaylist, getPlaylists, refreshPlaylists } from './musicPlaylists';
import { openNewPlaylist } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSheet from '../notes/PvSheet';

import styles from './MusicPlaylistPicker.module.scss';

type OwnProps = {
  tracks: MusicTrack[];
  // Подпись под заголовком вместо «название · исполнитель» (трек каталога: «… · из каталога»)
  subtitle?: string;
  // Трек ещё не на сервере: выбор отдаётся наружу, добавит его тот, кто скачивает (`fetch/musicFetch.ts`)
  onPick?: (playlists: { id: string; isShared: boolean }[]) => void;
  onClose: NoneToVoidFunction;
};

type Option = {
  key: string;
  id: string;
  isShared: boolean;
  name: string;
  sub: string;
  // Трек (один) уже есть в этом плейлисте
  hasTrack: boolean;
};

// Parvane (макет «Музыки» 23 ноя, доска `MusicPlaylist-04`): «В плейлист…» — поиск по плейлистам, «Новый плейлист»,
// свои и общие (где можно добавлять) с флажками, «Готово» добавляет в отмеченные. Где трек уже есть — «уже есть»
const MusicPlaylistPicker = ({
  tracks, subtitle: subtitleText, onPick, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const shared = useDerivedState(getSharedPlaylists);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const single = tracks.length === 1 ? tracks[0] : undefined;

  useEffect(() => {
    void refreshPlaylists();
    void refreshSharedPlaylists();
  }, []);

  const options = useMemo<Option[]>(() => [
    ...playlists.map((playlist) => ({
      key: `p:${playlist.id}`,
      id: playlist.id,
      isShared: false,
      name: playlist.name,
      sub: lang('MusicTracksCount', { count: playlist.count }, { pluralValue: playlist.count }),
      hasTrack: Boolean(single && playlist.items.some((item) => item.trackId === single.id)),
    })),
    ...shared.filter((playlist) => canEditTracks(playlist.myRole)).map((playlist) => ({
      key: `s:${playlist.id}`,
      id: playlist.id,
      isShared: true,
      name: playlist.name,
      sub: lang('MusicPickerShared', { count: playlist.trackCount }, { pluralValue: playlist.trackCount }),
      hasTrack: false,
    })),
  ], [playlists, shared, single, lang]);
  const text = query.trim().toLowerCase();
  const shown = text ? options.filter((option) => option.name.toLowerCase().includes(text)) : options;

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value));
  const handleToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const key = e.currentTarget.dataset.key!;
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  });
  const handleNew = useLastCallback(() => {
    onClose();
    openNewPlaylist(single);
  });
  const handleDone = useLastCallback(async () => {
    const chosen = options.filter((option) => picked.has(option.key));
    if (!chosen.length) {
      onClose();
      return;
    }
    if (onPick) {
      onPick(chosen.map((option) => ({ id: option.id, isShared: option.isShared })));
      onClose();
      return;
    }
    setIsSaving(true);
    const results = await Promise.all(chosen.map((option) => (option.isShared
      ? addTracksToShared(option.id, tracks.map(toTrackInput)).then((skipped) => skipped !== undefined)
      : addTracksToPlaylist(option.id, tracks).then(Boolean))));
    setIsSaving(false);
    const isAllDone = results.every(Boolean);
    showNotification({
      message: isAllDone ? lang('MusicAddedTo', { name: chosen.map((option) => option.name).join(', ') })
        : lang('MusicPlaylistFailed'),
    });
    onClose();
  });

  const subtitle = subtitleText || (single
    ? [single.artist ? `${single.title} · ${single.artist}` : single.title].join('')
    : lang('MusicTracksCount', { count: tracks.length }, { pluralValue: tracks.length }));

  return (
    <PvSheet isOpen title={lang('MusicPickerTitle')} subtitle={subtitle} onClose={onClose}>
      <div className={styles.root} data-playlist-picker>
        <input
          className={styles.search}
          type="search"
          value={query}
          placeholder={lang('MusicPickerSearch')}
          aria-label={lang('MusicPickerSearch')}
          onChange={handleQuery}
        />
        <button type="button" className={styles.newRow} data-picker-new onClick={handleNew}>
          <ParvaneIcon name="plus" isSmall />
          {lang('MusicPlaylistNew')}
        </button>
        <div className={styles.list} role="group">
          {shown.map((option) => {
            const isOn = option.hasTrack || picked.has(option.key);
            return (
              <button
                key={option.key}
                type="button"
                role="checkbox"
                aria-checked={isOn}
                className={styles.row}
                disabled={option.hasTrack}
                data-key={option.key}
                data-playlist={option.id}
                onClick={handleToggle}
              >
                <span className={buildClassName(styles.box, isOn && styles.boxOn)}>
                  {isOn && <ParvaneIcon name="check" isSmall />}
                </span>
                <span className={styles.text}>
                  <span className={styles.name}>{option.name}</span>
                  <span className={styles.sub}>{option.hasTrack ? lang('MusicPickerAlready') : option.sub}</span>
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={styles.done}
          disabled={isSaving}
          data-picker-done
          onClick={handleDone}
        >
          {lang('MusicPickerDone')}
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(MusicPlaylistPicker);
