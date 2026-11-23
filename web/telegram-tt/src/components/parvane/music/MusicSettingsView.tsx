import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicStreamQuality } from '../../../api/parvane/musicApi';
import type {
  MusicPerson, MusicScanStatus, MusicServerField, MusicServerSettings,
} from '../../../api/parvane/musicFilesApi';

import buildClassName from '../../../util/buildClassName';
import { formatMusicDate } from './musicFormat';
import { getMusicMix } from './musicMix';
import { getOfflineBytes, getOfflineSettings, getOfflineState, removeOffline } from './musicOffline';
import { callMusic, getMusicInfo, loadMusicInfo } from './musicPlayer';
import { getMusicPrefs, setMusicPrefs } from './musicPrefs';
import { goBackMusic, openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSheet from '../notes/PvSheet';
import PvSkeleton from '../notes/PvSkeleton';
import PvSwitch from '../notes/PvSwitch';
import MusicSectionHead from './MusicSectionHead';
import { formatMusicSize } from './MusicSize';

import styles from './MusicSettings.module.scss';

type OwnProps = {
  page: 'mine' | 'server' | 'people';
  isPhone?: boolean;
};

type Server = Awaited<ReturnType<typeof loadServer>>;

const GB = 1024 * 1024 * 1024;
const MIX_MODE_KEYS = {
  normal: 'MusicMixModeNormal', favorites: 'MusicMixModeFavorites', discover: 'MusicMixModeDiscover',
} as const;
const MB = 1024 * 1024;

// Parvane (макет «Музыки» 23 ноя, доски `MusicSettings`, `ZdMusicX-06`): «Настройки музыки · для вас» (настройки
// устройства), «Музыка на сервере · для администратора» (источники, лимиты по умолчанию, библиотека) и «Люди и
// лимиты» (свой лимит человека, «без каталога», кто удаляет чужое). На компьютере «для вас» и «сервер» — рядом
const MusicSettingsView = ({ page, isPhone }: OwnProps) => {
  const lang = useLang();
  const info = useDerivedState(getMusicInfo);
  const [server, setServer] = useState<Server>();

  useEffect(() => {
    if (page === 'mine' && (isPhone || !info?.isAdmin)) return;
    void loadServer().then(setServer, () => undefined);
  }, [page, isPhone, info?.isAdmin]);

  const handlePeopleCount = useLastCallback((count: number) => {
    setServer((previous) => previous && { ...previous, people: count });
  });

  const title = page === 'people' ? lang('MusicPeopleLimits') : page === 'server' ? lang('MusicServerTitle')
    : lang('MusicSettings');
  const subtitle = page === 'people' ? lang('MusicPeopleCount', { count: server?.people || 0 })
    : page === 'server' ? lang('MusicForAdmin') : lang('MusicForYou');

  return (
    <div
      className={buildClassName(styles.root, !isPhone && page === 'mine' && styles.rootDesk)}
      data-music-settings={page}
    >
      <MusicSectionHead title={title} barSubtitle={subtitle} isPhone={isPhone} onBack={goBackMusic} />
      {page === 'people' ? <People onCount={handlePeopleCount} /> : (
        <div className={styles.columns}>
          {page === 'mine' && <Mine isPhone={isPhone} isAdmin={Boolean(info?.isAdmin)} />}
          {(page === 'server' || (!isPhone && info?.isAdmin)) && (
            server ? <ServerSettings server={server} onChange={setServer} isPhone={isPhone} /> : <PvSkeleton />
          )}
        </div>
      )}
    </div>
  );
};

async function loadServer() {
  return callMusic('parvaneMusicAdminGet');
}

// «Для вас»: качество, громкость, каталог, миксы, место на устройстве
const Mine = memo(({ isPhone, isAdmin }: { isPhone?: boolean; isAdmin: boolean }) => {
  const lang = useLang();
  const prefs = useDerivedState(getMusicPrefs);
  const offline = useDerivedState(getOfflineState);
  const offlineSettings = useDerivedState(getOfflineSettings);
  const [isQualityOpen, setIsQualityOpen] = useState(false);
  const mixSettings = useDerivedState(getMusicMix)?.settings;
  const qualityName = (quality: MusicStreamQuality) => (
    lang(quality === 'original' ? 'MusicQualityOriginal' : 'MusicQualityLight')
  );

  const handleNormalize = useLastCallback((isOn: boolean) => setMusicPrefs({ isNormalized: isOn }));
  const handleCatalog = useLastCallback((isOn: boolean) => setMusicPrefs({ isCatalogSearch: isOn }));
  const handleOpenQuality = useLastCallback(() => setIsQualityOpen(true));
  const handleCloseQuality = useLastCallback(() => setIsQualityOpen(false));
  const handleQuality = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { net, value } = e.currentTarget.dataset;
    const quality = value as MusicStreamQuality;
    setMusicPrefs(net === 'wifi' ? { wifiQuality: quality } : { cellQuality: quality });
  });
  const handleMix = useLastCallback(() => openMusicView({ kind: 'mix' }));
  const handleOffline = useLastCallback(() => openMusicView({ kind: 'offline' }));
  const handleClear = useLastCallback(() => void removeOffline());
  const handleServer = useLastCallback(() => openMusicView({ kind: 'serverSettings' }));

  return (
    <div className={styles.column}>
      {!isPhone && <h2 className={styles.columnTitle}>{lang('MusicForYouTitle')}</h2>}
      <div className={styles.caps}>{lang('MusicSound')}</div>
      <div className={styles.card}>
        <button type="button" className={styles.row} onClick={handleOpenQuality}>
          <span className={styles.label}>{lang('MusicQuality')}</span>
          <span className={styles.value}>
            {lang('MusicQualityValue', { wifi: qualityName(prefs.wifiQuality), cell: qualityName(prefs.cellQuality) })}
          </span>
          <ParvaneIcon name="right" isSmall className={styles.chevron} />
        </button>
        <div className={styles.row}>
          <span className={styles.label}>{lang('MusicNormalize')}</span>
          <PvSwitch isOn={prefs.isNormalized} label={lang('MusicNormalize')} onChange={handleNormalize} />
        </div>
      </div>
      <div className={styles.caps}>{lang('MusicCatalogCaps')}</div>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.text}>
            <span className={styles.label}>{lang('MusicSearchCatalog')}</span>
            <span className={styles.sub}>{lang('MusicSearchCatalogHint')}</span>
          </span>
          <PvSwitch isOn={prefs.isCatalogSearch} label={lang('MusicSearchCatalog')} onChange={handleCatalog} />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{lang('MusicFavFromCatalog')}</span>
          <span className={styles.value}>{lang('MusicAddToServer')}</span>
        </div>
      </div>
      <div className={styles.caps}>{lang('MusicMixesCaps')}</div>
      <div className={styles.card}>
        <button type="button" className={styles.row} onClick={handleMix}>
          <span className={styles.label}>{lang('MusicMixModeTime')}</span>
          {mixSettings && (
            <span className={styles.value}>
              {`${lang(MIX_MODE_KEYS[mixSettings.mode])} · ${String(mixSettings.hour).padStart(2, '0')}:00`}
            </span>
          )}
          <ParvaneIcon name="right" isSmall className={styles.chevron} />
        </button>
      </div>
      <div className={styles.caps}>{lang(isPhone ? 'MusicOnPhone' : 'MusicOnComputer')}</div>
      <div className={styles.card}>
        <button type="button" className={styles.row} onClick={handleOffline}>
          <span className={styles.label}>{lang('MusicOfflineSpace')}</span>
          <span
            className={styles.value}
          >
            {lang('MusicUpTo', { size: formatMusicSize(lang, offlineSettings.limitBytes) })}
          </span
          >
          <ParvaneIcon name="right" isSmall className={styles.chevron} />
        </button>
        {Boolean(offline.entries.length) && (
          <button type="button" className={buildClassName(styles.row, styles.danger)} onClick={handleClear}>
            {lang('MusicClearDownloaded', { size: formatMusicSize(lang, getOfflineBytes(offline)) })}
          </button>
        )}
      </div>
      {isPhone && isAdmin && (
        <div className={styles.card}>
          <button type="button" className={styles.row} data-music-server-settings onClick={handleServer}>
            <span className={styles.label}>{lang('MusicServerTitle')}</span>
            <ParvaneIcon name="right" isSmall className={styles.chevron} />
          </button>
        </div>
      )}
      <PvSheet isOpen={isQualityOpen} title={lang('MusicQuality')} onClose={handleCloseQuality}>
        {(['wifi', 'cell'] as const).map((net) => (
          <div key={net} className={styles.sheetGroup}>
            <div className={styles.caps}>{lang(net === 'wifi' ? 'MusicByWifi' : 'MusicByCellular')}</div>
            <div className={styles.segment} role="radiogroup">
              {(['original', 'opus'] as const).map((value) => {
                const isOn = (net === 'wifi' ? prefs.wifiQuality : prefs.cellQuality) === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={isOn}
                    className={buildClassName(styles.segmentItem, isOn && styles.segmentOn)}
                    data-net={net}
                    data-value={value}
                    onClick={handleQuality}
                  >
                    {qualityName(value)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </PvSheet>
    </div>
  );
});

// «Музыка на сервере · для администратора»
const ServerSettings = memo(({ server, isPhone, onChange }: {
  server: Server; isPhone?: boolean; onChange: (server: Server) => void;
}) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [editing, setEditing] = useState<'per_day' | 'quota_bytes' | 'upload_max_bytes'>();
  const [draft, setDraft] = useState('');
  const [scan, setScan] = useState<MusicScanStatus>(server.scan);
  const { settings, isAdmin } = server;

  const save = useLastCallback(async (change: Partial<MusicServerSettings>, fields: MusicServerField[]) => {
    const next = await callMusic('parvaneMusicAdminSet', { settings: { ...settings, ...change }, fields })
      .catch(() => undefined);
    if (!next) {
      showNotification({ message: lang('MusicPlaylistFailed') });
      return;
    }
    onChange({ ...server, settings: next });
    void loadMusicInfo();
  });
  const handleLinks = useLastCallback((isOn: boolean) => void save({ hasLinks: isOn }, ['links']));
  const handleUploads = useLastCallback((isOn: boolean) => void save({ hasUploads: isOn }, ['uploads']));
  const handleEdit = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const key = e.currentTarget.dataset.key as 'per_day' | 'quota_bytes' | 'upload_max_bytes';
    setEditing(key);
    setDraft(String(key === 'per_day' ? settings.perDay : key === 'quota_bytes'
      ? Math.round(settings.quotaBytes / GB) : Math.round(settings.uploadMaxBytes / MB)));
  });
  const handleDraft = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.currentTarget.value));
  const handleCloseEdit = useLastCallback(() => setEditing(undefined));
  const handleSaveEdit = useLastCallback(() => {
    const value = Math.max(0, Math.round(Number(draft) || 0));
    if (editing === 'per_day') void save({ perDay: value }, ['per_day']);
    else if (editing === 'quota_bytes') void save({ quotaBytes: value * GB }, ['quota_bytes']);
    else if (editing === 'upload_max_bytes') {
      void save({ uploadMaxBytes: Math.max(1, value) * MB }, ['upload_max_bytes']);
    }
    setEditing(undefined);
  });
  const handleScan = useLastCallback(async () => {
    const next = await callMusic('parvaneMusicAdminScan').catch(() => undefined);
    if (next) setScan({ ...next, isScanning: true });
  });
  const handlePeople = useLastCallback(() => openMusicView({ kind: 'people' }));
  const handleTrash = useLastCallback(() => openMusicView({ kind: 'trash' }));

  function renderValueRow(key: 'per_day' | 'quota_bytes' | 'upload_max_bytes', label: string, value: string) {
    return (
      <button type="button" className={styles.row} data-key={key} disabled={!isAdmin} onClick={handleEdit}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{value}</span>
        {isAdmin && <ParvaneIcon name="right" isSmall className={styles.chevron} />}
      </button>
    );
  }

  const scanText = scan.isScanning ? lang('MusicScanning')
    : scan.lastScanMs
      ? lang('MusicScanLast', { date: formatMusicDate(lang, scan.lastScanMs) })
      : lang('MusicScanNever');

  return (
    <div className={styles.column}>
      {!isPhone && <h2 className={styles.columnTitle}>{lang('MusicServerAdminTitle')}</h2>}
      <div className={styles.caps}>{lang('MusicSourcesCaps')}</div>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.text}>
            <span className={styles.label}>{lang('MusicSourcesCatalog')}</span>
            <span className={styles.sub}>
              {lang(server.isFetchEnabled ? 'MusicSourcesCatalogOn' : 'MusicSourcesCatalogOff')}
            </span>
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.text}>
            <span className={styles.label}>{lang('MusicSourcesLinks')}</span>
            <span className={styles.sub}>{lang('MusicAddLinkSub')}</span>
          </span>
          <PvSwitch
            isOn={settings.hasLinks}
            isDisabled={!isAdmin}
            label={lang('MusicSourcesLinks')}
            onChange={handleLinks}
          />
        </div>
        <div className={styles.row}>
          <span className={styles.text}>
            <span className={styles.label}>{lang('MusicSourcesUploads')}</span>
            <span className={styles.sub}>
              {lang('MusicUpToPerFile', { size: formatMusicSize(lang, settings.uploadMaxBytes) })}
            </span>
          </span>
          <PvSwitch
            isOn={settings.hasUploads}
            isDisabled={!isAdmin}
            label={lang('MusicSourcesUploads')}
            onChange={handleUploads}
          />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Soulseek</span>
          <span className={styles.later}>{lang('MusicLater')}</span>
        </div>
      </div>
      <div className={styles.caps}>{lang('MusicDefaultLimits')}</div>
      <div className={styles.card}>
        {renderValueRow('per_day', lang('MusicTracksPerDay'), String(settings.perDay))}
        {renderValueRow('quota_bytes', lang('MusicLimitSpace'), formatMusicSize(lang, settings.quotaBytes))}
        {renderValueRow('upload_max_bytes', lang('MusicLimitFile'), formatMusicSize(lang, settings.uploadMaxBytes))}
        <div className={styles.row}>
          <span className={styles.label}>{lang('MusicLimitParallel')}</span>
          <span className={styles.value}>
            {lang('MusicParallelValue', { count: server.parallel }, { pluralValue: server.parallel })}
          </span>
        </div>
        {isAdmin && (
          <button type="button" className={styles.row} data-music-people onClick={handlePeople}>
            <span className={styles.label}>{lang('MusicPeopleOwnLimits')}</span>
            <span className={styles.value}>{server.people}</span>
            <ParvaneIcon name="right" isSmall className={styles.chevron} />
          </button>
        )}
      </div>
      <div className={styles.caps}>{lang('MusicLibraryCaps')}</div>
      <div className={styles.card}>
        {Boolean(server.libraryDir) && (
          <div className={styles.row}>
            <span className={styles.label}>{lang('MusicFolder')}</span>
            <span className={buildClassName(styles.value, styles.mono)}>{server.libraryDir}</span>
          </div>
        )}
        <div className={styles.row}>
          <span className={styles.text}>
            <span className={styles.label}>{lang('MusicScanTitle')}</span>
            <span className={styles.sub}>{scanText}</span>
          </span>
          {isAdmin && (
            <button
              type="button"
              className={styles.pill}
              disabled={scan.isScanning}
              data-music-scan
              onClick={handleScan}
            >
              {lang('MusicScanNow')}
            </button>
          )}
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{lang('MusicDuplicates')}</span>
          <span className={styles.value}>{lang('MusicDuplicatesFound', { count: server.duplicates })}</span>
        </div>
        <button type="button" className={styles.row} onClick={handleTrash}>
          <span className={styles.label}>{lang('MusicTrash')}</span>
          <span className={styles.value}>{lang('MusicTrashDays')}</span>
          <ParvaneIcon name="right" isSmall className={styles.chevron} />
        </button>
      </div>
      <PvSheet isOpen={Boolean(editing)} title={lang('MusicChangeLimit')} onClose={handleCloseEdit}>
        <div className={styles.sheetGroup}>
          <label className={styles.text}>
            <span className={styles.sub}>
              {lang(editing === 'per_day' ? 'MusicTracksPerDay' : editing === 'quota_bytes' ? 'MusicLimitSpaceGb'
                : 'MusicLimitFileMb')}
            </span>
            <input className={styles.input} inputMode="numeric" value={draft} onChange={handleDraft} />
          </label>
          <button type="button" className={styles.primary} onClick={handleSaveEdit}>{lang('Save')}</button>
        </div>
      </PvSheet>
    </div>
  );
});

// «Люди и лимиты»
const People = memo(({ onCount }: { onCount: (count: number) => void }) => {
  const lang = useLang();
  const [people, setPeople] = useState<MusicPerson[]>();
  const [settings, setSettings] = useState<MusicServerSettings>();
  const [editing, setEditing] = useState<MusicPerson>();
  const [draft, setDraft] = useState('');
  const [isNoCatalog, setIsNoCatalog] = useState(false);

  useEffect(() => {
    void callMusic('parvaneMusicAdminPeople').then((list) => {
      setPeople(list);
      onCount(list.length);
    }, () => setPeople([]));
    void callMusic('parvaneMusicAdminGet').then((server) => setSettings(server.settings), () => undefined);
  }, [onCount]);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const person = people?.find((item) => item.address === e.currentTarget.dataset.address);
    if (!person) return;
    setEditing(person);
    setDraft(person.hasOwnLimit ? String(person.perDay) : '');
    setIsNoCatalog(person.isNoCatalog);
  });
  const handleClose = useLastCallback(() => setEditing(undefined));
  const handleDraft = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.currentTarget.value));
  const handleNoCatalog = useLastCallback((isOn: boolean) => setIsNoCatalog(isOn));
  const handleSave = useLastCallback(async () => {
    if (!editing) return;
    const perDay = Math.round(Number(draft));
    const updated = await callMusic('parvaneMusicAdminPersonSet', {
      address: editing.address, perDay: perDay || 0, isReset: !draft.trim(), isNoCatalog,
    }).catch(() => undefined);
    if (updated) setPeople((previous) => previous?.map((item) => (item.address === updated.address ? updated : item)));
    setEditing(undefined);
  });
  const saveFlag = useLastCallback(async (change: Partial<MusicServerSettings>, field: MusicServerField) => {
    if (!settings) return;
    const next = await callMusic('parvaneMusicAdminSet', { settings: { ...settings, ...change }, fields: [field] })
      .catch(() => undefined);
    if (next) setSettings(next);
  });
  const handleOnlyAdmins = useLastCallback((isOn: boolean) => {
    void saveFlag({ isOnlyAdminsDelete: isOn }, 'only_admins_delete');
  });
  const handleConfirm = useLastCallback((isOn: boolean) => {
    void saveFlag({ isConfirmAlbumDelete: isOn }, 'confirm_album_delete');
  });

  if (!people) return <PvSkeleton />;

  return (
    <div className={styles.column} data-music-people-list={people.length}>
      <p className={styles.note}>{lang('MusicPeopleNote')}</p>
      <div className={styles.card}>
        {people.map((person) => (
          <button
            key={person.address}
            type="button"
            className={styles.row}
            data-address={person.address}
            onClick={handleOpen}
          >
            <span className={styles.avatar}>{person.nick.slice(0, 1).toUpperCase()}</span>
            <span className={styles.text}>
              <span className={styles.label}>{person.nick}</span>
              <span className={styles.sub}>
                {person.isAdmin ? lang('MusicAdminRole') : person.isNoCatalog ? lang('MusicNoCatalog')
                  : lang('MusicPersonUsage', { today: person.today, size: formatMusicSize(lang, person.bytes) })}
              </span>
            </span>
            <span className={buildClassName(styles.value, styles.mono)}>{person.isAdmin ? '∞' : person.perDay}</span>
            <ParvaneIcon name="right" isSmall className={styles.chevron} />
          </button>
        ))}
      </div>
      {settings && (
        <>
          <div className={styles.caps}>{lang('MusicWhoDeletes')}</div>
          <div className={styles.card}>
            <div className={styles.row}>
              <span className={styles.label}>{lang('MusicOnlyAdmins')}</span>
              <PvSwitch
                isOn={settings.isOnlyAdminsDelete}
                label={lang('MusicOnlyAdmins')}
                onChange={handleOnlyAdmins}
              />
            </div>
            <div className={styles.row}>
              <span className={styles.label}>{lang('MusicConfirmAlbumDelete')}</span>
              <PvSwitch
                isOn={settings.isConfirmAlbumDelete}
                label={lang('MusicConfirmAlbumDelete')}
                onChange={handleConfirm}
              />
            </div>
          </div>
        </>
      )}
      <PvSheet isOpen={Boolean(editing)} title={editing?.nick} subtitle={lang('MusicOwnLimit')} onClose={handleClose}>
        <div className={styles.sheetGroup}>
          <label className={styles.text}>
            <span className={styles.sub}>{lang('MusicTracksPerDay')}</span>
            <input
              className={styles.input}
              inputMode="numeric"
              value={draft}
              placeholder={lang('MusicCommonLimit', { count: settings?.perDay || 0 })}
              onChange={handleDraft}
            />
          </label>
          <div className={styles.row}>
            <span className={styles.text}>
              <span className={styles.label}>{lang('MusicNoCatalogTitle')}</span>
              <span className={styles.sub}>{lang('MusicNoCatalogHint')}</span>
            </span>
            <PvSwitch isOn={isNoCatalog} label={lang('MusicNoCatalogTitle')} onChange={handleNoCatalog} />
          </div>
          <button type="button" className={styles.primary} onClick={handleSave}>{lang('Save')}</button>
        </div>
      </PvSheet>
    </div>
  );
});

export default memo(MusicSettingsView);
