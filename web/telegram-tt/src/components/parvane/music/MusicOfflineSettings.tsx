import { memo } from '../../../lib/teact/teact';

import type { MusicStreamQuality } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { getOfflineSettings, OFFLINE_LIMIT_CHOICES, setOfflineSettings } from './musicOffline';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSwitch from '../notes/PvSwitch';
import { formatMusicSize } from './MusicSize';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  // Предел загруженного — выбором (в «Данные и память» и окне «Изменить лимит»)
  withLimit?: boolean;
  // Выключатель «Скачивать новое» и «Качество» (экран «Загруженное», доска `RdMusic`)
  withRules?: boolean;
};

const QUALITIES: MusicStreamQuality[] = ['original', 'opus'];
const QUALITY_KEYS = { original: 'MusicQualityOriginal', opus: 'MusicQualityOpus' } as const;

// Parvane (spec 041, доски `XpMusic`, `RdMusic`): настройки «Загруженного» на этом устройстве — предел места,
// качество загрузки, докачка нового в загруженных плейлистах. Качество потока при прослушивании выбирается само
const MusicOfflineSettings = ({ withLimit, withRules }: OwnProps) => {
  const lang = useLang();
  const settings = useDerivedState(getOfflineSettings);

  const handleLimit = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setOfflineSettings({ limitBytes: Number(e.currentTarget.value) });
  });
  const handleQuality = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setOfflineSettings({ quality: e.currentTarget.value as MusicStreamQuality });
  });
  const handleFollow = useLastCallback((isOn: boolean) => setOfflineSettings({ shouldFollowNew: isOn }));

  return (
    <div className={styles.settingRows} data-music-offline-settings>
      {withLimit && (
        <label className={styles.settingRow}>
          <span className={kit.grow}>{lang('MusicOfflineLimitLabel')}</span>
          <select
            className={buildClassName(kit.input, styles.settingSelect)}
            value={String(settings.limitBytes)}
            data-music-offline-limit
            onChange={handleLimit}
          >
            {OFFLINE_LIMIT_CHOICES.map((bytes) => (
              <option key={bytes} value={String(bytes)}>{formatMusicSize(lang, bytes)}</option>
            ))}
          </select>
        </label>
      )}
      {withRules && (
        <PvSwitch isOn={settings.shouldFollowNew} className={styles.settingRow} onChange={handleFollow}>
          <span className={kit.grow}>{lang('MusicOfflineFollowNew')}</span>
        </PvSwitch>
      )}
      {withRules && (
        <label className={styles.settingRow}>
          <span className={kit.grow}>{lang('MusicOfflineQuality')}</span>
          <select
            className={buildClassName(kit.input, styles.settingSelect)}
            value={settings.quality}
            data-music-offline-quality
            onChange={handleQuality}
          >
            {QUALITIES.map((quality) => (
              <option key={quality} value={quality}>{lang(QUALITY_KEYS[quality])}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
};

export default memo(MusicOfflineSettings);
