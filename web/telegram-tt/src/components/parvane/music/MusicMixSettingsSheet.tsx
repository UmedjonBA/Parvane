import { memo } from '../../../lib/teact/teact';

import type { MusicMixMode } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  closeMixSettings, getIsMixSettingsOpen, getMusicMix, loadMusicMix,
} from './musicMix';
import { callMusic } from './musicPlayer';
import { openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSegment from '../notes/PvSegment';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicMixArtists.module.scss';

// Знакомое · Смесь · Новое (доска `MusicHome-04`)
const MODES: MusicMixMode[] = ['favorites', 'normal', 'discover'];
const MODE_KEYS = {
  favorites: 'MusicMixWhatFamiliar', normal: 'MusicMixWhatMixed', discover: 'MusicMixWhatNew',
} as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// Parvane (макет «Музыки» 23 ноя, доска `MusicHome-04`): настройки «Микса дня» листом — шапка с обложкой микса
// и «исполнители · N треков», «Что в миксе», «Обновлять каждый день в», исполнители чипами и «Изменить», «Готово».
// Правка сохраняется сразу
const MusicMixSettingsSheet = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getIsMixSettingsOpen);
  const today = useDerivedState(getMusicMix);
  const settings = today?.settings;

  const handleMode = useLastCallback(async (mode: MusicMixMode) => {
    await callMusic('parvaneMusicMixSettings', { mode }).catch(() => undefined);
    void loadMusicMix();
  });
  const handleHour = useLastCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    await callMusic('parvaneMusicMixSettings', { hour: Number(e.currentTarget.value) }).catch(() => undefined);
    void loadMusicMix();
  });
  const handleArtists = useLastCallback(() => {
    closeMixSettings();
    openMusicView({ kind: 'mixArtists' });
  });

  const artists = settings?.artists || [];
  const count = today?.mix?.tracks.length || 0;
  const facts = [
    artists.slice(0, 3).map((artist) => artist.name).join(', '),
    count ? lang('MusicTracksCount', { count }, { pluralValue: count }) : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <PvSheet
      isOpen={isOpen && Boolean(settings)}
      title={lang('MusicMixTitle')}
      subtitle={facts}
      headBefore={(
        <span className={styles.sheetCover} aria-hidden>
          <ParvaneIcon name="wave" />
        </span>
      )}
      noClose
      onClose={closeMixSettings}
    >
      {settings && (
        <div className={styles.sheet} data-music-mix-settings>
          <div className={styles.sheetBlock}>
            <span className={styles.sheetLabel}>{lang('MusicMixWhat')}</span>
            <PvSegment
              items={MODES.map((mode) => ({ value: mode, label: lang(MODE_KEYS[mode]) }))}
              value={settings.mode}
              label={lang('MusicMixWhat')}
              onChange={handleMode}
            />
          </div>
          <label className={styles.sheetRow}>
            <span className={styles.sheetRowText}>{lang('MusicMixDailyAt')}</span>
            <select
              className={buildClassName(kit.input, styles.sheetHour)}
              value={String(settings.hour)}
              data-music-mix-hour
              onChange={handleHour}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={String(hour)}>{`${String(hour).padStart(2, '0')}:00`}</option>
              ))}
            </select>
          </label>
          <div className={styles.sheetBlock}>
            <span className={styles.sheetLabel}>{lang('MusicArtists')}</span>
            <div className={kit.chips}>
              {artists.map((artist) => <span key={artist.ref} className={kit.chip}>{artist.name}</span>)}
              <button
                type="button"
                className={buildClassName(kit.chip, styles.sheetEdit)}
                data-music-mix-artists-edit
                onClick={handleArtists}
              >
                {lang('MusicMixArtistsEdit')}
              </button>
            </div>
          </div>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc, styles.sheetDone)}
            data-music-mix-settings-done
            onClick={closeMixSettings}
          >
            {lang('MusicMixArtistsDone')}
          </button>
        </div>
      )}
    </PvSheet>
  );
};

export default memo(MusicMixSettingsSheet);
