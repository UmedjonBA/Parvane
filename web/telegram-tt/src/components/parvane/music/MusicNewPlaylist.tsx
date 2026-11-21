import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicPlaylistAccess } from './shared/musicShared';

import buildClassName from '../../../util/buildClassName';
import { createSharedPlaylist, toTrackInput } from './shared/musicShared';
import { getCurrentTrack, getMusicPlayer } from './musicPlayer';
import { actOnPlaylists, addTracksToPlaylist } from './musicPlaylists';
import { closeNewPlaylist, getNewPlaylist, openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';
import PvSwitch from '../notes/PvSwitch';
import MusicAccessPicker from './shared/MusicAccessPicker';

import sheets from '../cloud/CloudSheets.module.scss';
import kit from '../notes/PvKit.module.scss';
import styles from './MusicSection.module.scss';

const NAME_MAX = 120;

// Parvane (spec 041, доски `RpMusicB`, `ZdMusicX`): окно «Новый плейлист» — из «+» модуля, «+» у плейлистов, «Новый…»
// в меню трека. Название, «Сразу добавить «трек»» (трек из меню либо играющий сейчас), «Отмена / Создать».
// «Кто видит» — «Только я» (личный) либо общий плейлист на сервере (MUSIC-3, `music/shared/`)
const MusicNewPlaylist = () => {
  const { showNotification } = getActions();
  const lang = useLang();
  const request = useDerivedState(getNewPlaylist);
  const player = useDerivedState(getMusicPlayer);
  const [name, setName] = useState('');
  const [shouldAdd, setShouldAdd] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [access, setAccess] = useState<MusicPlaylistAccess>('me');
  const track = request?.track || getCurrentTrack(player);
  const isFromTrack = Boolean(request?.track);

  // Поле пустое и выключатель включён — в кадр появления окна
  useLayoutEffect(() => {
    if (!request) return;
    setName('');
    setShouldAdd(true);
    setAccess('me');
  }, [request]);

  const handleName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setName(e.currentTarget.value));

  const handleCreate = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isBusy) return;
    setIsBusy(true);
    // Общий плейлист (MUSIC-3) — на сервере, сразу с треком
    if (access !== 'me') {
      const shared = await createSharedPlaylist(trimmed, access, track && shouldAdd ? [toTrackInput(track)] : []);
      setIsBusy(false);
      closeNewPlaylist();
      if (!shared) showNotification({ message: lang('MusicPlaylistFailed') });
      else if (isFromTrack) showNotification({ message: lang('MusicPlaylistCreatedWith', { name: trimmed }) });
      else openMusicView({ kind: 'shared', id: shared.id });
      return;
    }
    const created = await actOnPlaylists({ action: 'create', name: trimmed });
    if (created?.id && track && shouldAdd) await addTracksToPlaylist(created.id, [track]);
    setIsBusy(false);
    closeNewPlaylist();
    if (!created?.id) {
      showNotification({ message: lang('MusicPlaylistFailed') });
      return;
    }
    if (isFromTrack) showNotification({ message: lang('MusicPlaylistCreatedWith', { name: trimmed }) });
    else openMusicView({ kind: 'playlist', id: created.id });
  });

  return (
    <PvSheet
      isOpen={Boolean(request)}
      title={lang('MusicPlaylistNew')}
      onClose={closeNewPlaylist}
      onEnter={handleCreate}
    >
      <form className={sheets.form} data-music-new-playlist-form onSubmit={handleCreate}>
        <label className={styles.field}>
          <span className={buildClassName(kit.muted, kit.small)}>{lang('MusicPlaylistNameLabel')}</span>
          <input
            className={kit.input}
            value={name}
            maxLength={NAME_MAX}
            placeholder={lang('MusicPlaylistNamePlaceholder')}
            aria-label={lang('MusicPlaylistNameLabel')}
            autoFocus
            onChange={handleName}
          />
        </label>
        <MusicAccessPicker value={access} onChange={setAccess} />
        {track && (
          <PvSwitch isOn={shouldAdd} data-music-add-current onChange={setShouldAdd}>
            <span className={styles.switchText}>
              <span>{lang('MusicPlaylistAddTrack', { name: track.title })}</span>
              {!isFromTrack && (
                <span className={buildClassName(kit.muted, kit.small)}>{lang('MusicPlaylistAddPlaying')}</span>
              )}
            </span>
          </PvSwitch>
        )}
        <div className={kit.sheetButtons}>
          <button type="button" className={kit.btn} onClick={closeNewPlaylist}>{lang('Cancel')}</button>
          <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)} disabled={!name.trim() || isBusy}>
            {lang('MusicPlaylistCreate')}
          </button>
        </div>
      </form>
    </PvSheet>
  );
};

export default memo(MusicNewPlaylist);
