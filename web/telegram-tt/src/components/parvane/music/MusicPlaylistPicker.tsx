import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  actOnPlaylists, addTracksToPlaylist, getPlaylists, getPlaylistsStatus, refreshPlaylists,
} from './musicPlaylists';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  track: MusicTrack;
  onClose: NoneToVoidFunction;
};

const DONE_DELAY_MS = 1500;

// Parvane (spec 039, этап C): «в плейлист» — выбор плейлиста для трека либо новый плейлист сразу с этим треком
const MusicPlaylistPicker = ({ track, onClose }: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const status = useDerivedState(getPlaylistsStatus);
  const [newName, setNewName] = useState('');
  const [outcome, setOutcome] = useState<'added' | 'present' | 'failed'>();

  useEffect(() => {
    void refreshPlaylists();
  }, []);

  useEffect(() => {
    if (!outcome || outcome === 'failed') return undefined;
    const timer = window.setTimeout(onClose, DONE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [outcome, onClose]);

  const addTo = useLastCallback(async (playlistId: string) => {
    const result = await addTracksToPlaylist(playlistId, [track]);
    setOutcome(!result ? 'failed' : result.skipped ? 'present' : 'added');
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void addTo(e.currentTarget.dataset.playlist!);
  });

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.currentTarget.value);
  });

  const handleCreate = useLastCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const created = await actOnPlaylists({ action: 'create', name });
    if (!created?.id) {
      setOutcome('failed');
      return;
    }
    await addTo(created.id);
  });

  const isUsable = status === 'ready' || status === 'loading';
  return (
    <section className={styles.picker} data-playlist-picker={outcome || 'open'}>
      <div className={styles.fetchLine}>
        <span className={kit.grow}>{lang('MusicAddToPlaylistTitle', { name: track.title })}</span>
        <button type="button" className={kit.btn} onClick={onClose}>{lang('Close')}</button>
      </div>
      {!isUsable && <div className={styles.error} role="status">{lang('MusicPlaylistsNeedLinking')}</div>}
      {outcome && (
        <div className={outcome === 'failed' ? styles.error : kit.muted} role="status">
          {lang(outcome === 'added' ? 'MusicPlaylistAdded' : outcome === 'present'
            ? 'MusicPlaylistAlreadyThere' : 'MusicPlaylistFailed')}
        </div>
      )}
      {isUsable && !outcome && (
        <>
          <div className={styles.pickerList}>
            {playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                className={kit.btn}
                data-playlist={playlist.id}
                onClick={handlePick}
              >
                {playlist.name}
              </button>
            ))}
          </div>
          <form className={styles.playlistForm} onSubmit={handleCreate}>
            <input
              className={buildClassName(kit.input, kit.grow)}
              value={newName}
              maxLength={120}
              placeholder={lang('MusicPlaylistNewPlaceholder')}
              aria-label={lang('MusicPlaylistNewPlaceholder')}
              onChange={handleNameChange}
            />
            <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)} disabled={!newName.trim()}>
              {lang('MusicPlaylistCreateAndAdd')}
            </button>
          </form>
        </>
      )}
    </section>
  );
};

export default memo(MusicPlaylistPicker);
