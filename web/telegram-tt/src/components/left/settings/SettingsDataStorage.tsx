import { memo, useEffect, useMemo, useState } from '../../../lib/teact/teact';

import type { AutoloadMode } from '../../../util/autoloadMode';
import type { CacheKeep } from '../../../util/cacheKeep';
import type { KeysFileTab } from './profile/profileRequests';
import type { CacheKind } from './profile/storageUsage';

import { AUTOLOAD_MODES, getAutoloadMode, setAutoloadMode } from '../../../util/autoloadMode';
import buildClassName from '../../../util/buildClassName';
import { CACHE_KEEP_CHOICES, getCacheKeep, setCacheKeep } from '../../../util/cacheKeep';
import { formatFileSize } from '../../../util/textFormat';
import { CACHE_KINDS, clearCache, measureCaches } from './profile/storageUsage';
import useKeysFileStatus from './profile/useKeysFileStatus';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import MusicOfflineSettings from '../../parvane/music/MusicOfflineSettings';
import KeysFileCard from './profile/KeysFileCard';
import KeysFileDialog from './profile/KeysFileDialog';
import ProfileChoiceSheet from './profile/ProfileChoiceSheet';
import ProfileIcon from './profile/ProfileIcon';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type Sheet = 'autoload' | 'keep';

const KIND_TITLES = {
  media: 'ParvaneStorageMedia',
  music: 'ParvaneStorageMusic',
  cloud: 'ParvaneStorageCloud',
  other: 'ParvaneStorageOther',
} as const satisfies Record<CacheKind, string>;
const AUTOLOAD_TITLES = {
  always: 'ParvaneAutoloadAlways',
  wifi: 'ParvaneAutoloadWifi',
  never: 'ParvaneAutoloadNever',
} as const satisfies Record<AutoloadMode, string>;
const KEEP_TITLES = {
  week: 'ParvaneCacheKeepWeek',
  month: 'ParvaneCacheKeepMonth',
  quarter: 'ParvaneCacheKeepQuarter',
  forever: 'ParvaneCacheKeepForever',
} as const satisfies Record<CacheKeep, string>;

// Parvane (доска `DkSettingsB`, «Копия ключей и память»): карточка файла копии ключей, объём кэша по видам с «Очистить»
// у каждого, «Автозагрузка медиа» и «Хранить кэш». Прежний экран Telegram (автозагрузка по типам чатов и предел
// размера файла) убран: его выключатели остаются в силе с прежними значениями, режим устройства действует поверх.
// Ниже — «Загруженное» «Музыки» (предел места и правила, доска `XpMusic`)
const SettingsDataStorage = ({ isActive, onReset }: OwnProps) => {
  const lang = useLang();
  const fileStatus = useKeysFileStatus(isActive);
  const [fileTab, setFileTab] = useState<KeysFileTab>();
  const [sizes, setSizes] = useState<Record<CacheKind, number>>();
  const [clearing, setClearing] = useState<CacheKind>();
  const [sheet, setSheet] = useState<Sheet>();
  const [autoload, setAutoload] = useState(getAutoloadMode);
  const [keep, setKeep] = useState(getCacheKeep);

  useHistoryBack({ isActive, onBack: onReset });

  const loadSizes = useLastCallback(async () => {
    setSizes(await measureCaches());
  });

  useEffect(() => {
    if (isActive) void loadSizes();
  }, [isActive, loadSizes]);

  const handleClear = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const kind = e.currentTarget.dataset.cacheClear as CacheKind;
    setClearing(kind);
    await clearCache(kind).catch(() => undefined);
    setClearing(undefined);
    void loadSizes();
  });

  const handleSelect = useLastCallback((value: string) => {
    if (sheet === 'autoload') {
      setAutoloadMode(value as AutoloadMode);
      setAutoload(value as AutoloadMode);
    } else {
      setCacheKeep(value as CacheKeep);
      setKeep(value as CacheKeep);
    }
  });

  const openSave = useLastCallback(() => setFileTab('save'));
  const openRestore = useLastCallback(() => setFileTab('restore'));
  const closeFile = useLastCallback(() => setFileTab(undefined));
  const closeSheet = useLastCallback(() => setSheet(undefined));

  const sheetOptions = useMemo(() => (sheet === 'autoload'
    ? AUTOLOAD_MODES.map((value) => ({ value, label: lang(AUTOLOAD_TITLES[value]) }))
    : CACHE_KEEP_CHOICES.map((value) => ({ value, label: lang(KEEP_TITLES[value]) }))), [sheet, lang]);

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-data>
      <KeysFileCard
        savedAt={fileStatus.savedAt}
        isStale={fileStatus.isStale}
        onSave={openSave}
        onRestore={openRestore}
      />

      <div className={styles.caption}>{lang('ParvaneStorageCaption')}</div>
      <div className={styles.group}>
        {CACHE_KINDS.map((kind) => (
          <div key={kind} className={styles.setRow} data-cache-row={kind}>
            <span className={styles.setTitle}>{lang(KIND_TITLES[kind])}</span>
            <span className={styles.setValue} data-cache-size={sizes ? sizes[kind] : undefined}>
              {sizes ? formatFileSize(lang, sizes[kind]) : '…'}
            </span>
            <button
              type="button"
              className={styles.chip}
              disabled={!sizes || !sizes[kind] || clearing !== undefined}
              data-cache-clear={kind}
              onClick={handleClear}
            >
              {lang('ParvaneStorageClear')}
            </button>
          </div>
        ))}
      </div>

      <div className={styles.group}>
        <button type="button" className={rowClass} data-storage-row="autoload" onClick={() => setSheet('autoload')}>
          <span className={styles.setTitle}>{lang('ParvaneAutoloadTitle')}</span>
          <span className={styles.menuValue} data-storage-value={autoload}>{lang(AUTOLOAD_TITLES[autoload])}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        <button type="button" className={rowClass} data-storage-row="keep" onClick={() => setSheet('keep')}>
          <span className={styles.setTitle}>{lang('ParvaneCacheKeepTitle')}</span>
          <span className={styles.menuValue} data-storage-value={keep}>{lang(KEEP_TITLES[keep])}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
      </div>
      <div className={styles.hint}>{lang('ParvaneStorageHint')}</div>

      <div className={styles.caption}>{lang('MusicOfflineSettingsTitle')}</div>
      <div className={styles.group}>
        <MusicOfflineSettings withLimit withRules />
      </div>

      <ProfileChoiceSheet
        isOpen={Boolean(sheet)}
        title={lang(sheet === 'autoload' ? 'ParvaneAutoloadTitle' : 'ParvaneCacheKeepTitle')}
        hint={sheet === 'autoload' ? lang('ParvaneAutoloadHint') : undefined}
        options={sheetOptions}
        selected={sheet === 'autoload' ? autoload : keep}
        onSelect={handleSelect}
        onClose={closeSheet}
      />
      <KeysFileDialog user={fileStatus.user} openTab={fileTab} onClose={closeFile} onDone={fileStatus.refresh} />
    </div>
  );
};

export default memo(SettingsDataStorage);
