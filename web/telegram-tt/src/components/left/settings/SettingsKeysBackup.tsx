import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import buildClassName from '../../../util/buildClassName';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';
import { formatBackupDate, getKeysBackupSavedAt, markKeysBackupSaved } from './profile/profileStatus';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import { DeviceKeyDialog } from './devices/DeviceDialogs';
import ProfileIcon from './profile/ProfileIcon';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

// Состав копии ключей аккаунта на сервере (`v2/keyBundle.ts describeKeyBundle`)
type KeyBundleContents = {
  hasChats: boolean;
  hasFiles: boolean;
  hasPlanner: boolean;
  hasHealth: boolean;
  hasMusic: boolean;
  groups: number;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const KEYS_PASSWORD_MIN_LENGTH = 8;
// «Что в копии»: строка — признак состава и её название
const BUNDLE_ROWS = [
  { part: 'chats', key: 'ParvaneKeysBundleChats' },
  { part: 'files', key: 'ParvaneKeysBundleFiles' },
  { part: 'planner', key: 'ParvaneKeysBundlePlanner' },
  { part: 'health', key: 'ParvaneKeysBundleHealth' },
  { part: 'music', key: 'ParvaneKeysBundleMusic' },
] as const;

// Parvane (spec 041 E3): «Профиль → Копия ключей» (доски `RpProfileB`, `ZdProfileX`) — файл под паролем с
// ключами и историей устройства. Прежде обе строки стояли на экране «Конфиденциальность»
const SettingsKeysBackup = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();

  const userId = getGlobal().currentUserId;
  const [savedAt, setSavedAt] = useState(() => getKeysBackupSavedAt(userId));

  const [isRenewOpen, setIsRenewOpen] = useState(false);
  const [contents, setContents] = useState<KeyBundleContents>();
  const [isContentsLoaded, setIsContentsLoaded] = useState(false);
  // Корень аккаунта на устройстве (RECOVER-1 п. 8): новый ключ создаётся без прежнего
  const [hasRoot, setHasRoot] = useState(false);

  useHistoryBack({ isActive, onBack: onReset });

  const loadContents = useLastCallback(async () => {
    setHasRoot(Boolean(await callParvane('parvaneHasStoredRoot')));
    const result = await callParvane('parvaneKeyBundleContents') as KeyBundleContents | undefined;
    setContents(result);
    setIsContentsLoaded(true);
  });

  useEffect(() => {
    if (isActive) void loadContents();
  }, [isActive, loadContents]);

  const openRenew = useLastCallback(() => setIsRenewOpen(true));
  const closeRenew = useLastCallback(() => setIsRenewOpen(false));

  const handleExport = useLastCallback(async () => {
    const password = window.prompt(oldLang('ParvaneKeysPasswordPrompt'));
    if (!password) return;
    // Копия держит закрытые ключи и историю: короткий пароль подбирается офлайн
    if (password.length < KEYS_PASSWORD_MIN_LENGTH) {
      showNotification({ message: oldLang('ParvaneKeysPasswordTooShort') });
      return;
    }
    const result = await callParvane('parvaneExportE2eKeys', { password }) as { payload: string } | undefined;
    if (!result) {
      showNotification({ message: oldLang('ParvaneKeysExportFailed') });
      return;
    }
    const blob = new Blob([result.payload], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'parvane-e2e-keys.json';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    markKeysBackupSaved(userId);
    setSavedAt(getKeysBackupSavedAt(userId));
    showNotification({ message: oldLang('ParvaneKeysExported') });
  });

  const handleImport = useLastCallback(() => {
    openSystemFilesDialog('.json', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      void (async () => {
        const password = window.prompt(oldLang('ParvaneKeysPasswordPrompt'));
        if (!password) return;
        const payload = await file.text();
        const result = await callParvane('parvaneImportE2eKeys', { payload, password });
        showNotification({
          message: oldLang(result ? 'ParvaneKeysImported' : 'ParvaneKeysImportFailed'),
        });
      })();
    }, true);
  });

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-keys>
      <div className={styles.hint} data-keys-saved-at={savedAt || undefined}>
        {savedAt
          ? lang('ParvaneKeysBackupSavedAt', { date: formatBackupDate(savedAt, lang.code) })
          : lang('ParvaneKeysBackupNone')}
      </div>
      <div className={styles.hint}>{lang('ParvaneKeysBackupHint')}</div>
      <div className={styles.group}>
        <button type="button" className={rowClass} data-keys-action="save" onClick={handleExport}>
          <span className={styles.setText}>
            <span className={styles.setTitle}>{lang('ParvaneKeysBackupSave')}</span>
            <span className={styles.setHint}>{lang('ParvaneKeysBackupSaveHint')}</span>
          </span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        <button type="button" className={rowClass} data-keys-action="restore" onClick={handleImport}>
          <span className={styles.setTitle}>{lang('ParvaneKeysBackupRestore')}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
      </div>

      <div className={styles.caption}>{lang('ParvaneRecoveryKeyCaption')}</div>
      <div className={styles.group}>
        <button type="button" className={rowClass} data-keys-action="renew" onClick={openRenew}>
          <span className={styles.setText}>
            <span className={styles.setTitle}>{lang('ParvaneRecoveryKeyRenew')}</span>
            <span className={styles.setHint}>{lang('ParvaneRecoveryKeyRenewHint')}</span>
          </span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
      </div>
      <div className={styles.hint}>{lang('ParvaneRecoveryKeyAbout')}</div>

      <div className={styles.caption}>{lang('ParvaneKeysBundleCaption')}</div>
      {contents ? (
        <div className={styles.group} data-keys-bundle>
          {BUNDLE_ROWS.map(({ part, key }) => (
            <div key={part} className={styles.setRow} data-bundle-part={part}>
              <span className={styles.setTitle}>{lang(key)}</span>
              <span className={styles.setValue}>
                {lang(hasPart(contents, part) ? 'ParvaneKeysBundleYes' : 'ParvaneKeysBundleNo')}
              </span>
            </div>
          ))}
          <div className={styles.setRow} data-bundle-part="groups">
            <span className={styles.setTitle}>{lang('ParvaneKeysBundleGroups')}</span>
            <span className={styles.setValue}>{contents.groups}</span>
          </div>
        </div>
      ) : (
        <div className={styles.hint} data-keys-bundle-none={isContentsLoaded || undefined}>
          {lang(isContentsLoaded ? 'ParvaneKeysBundleNone' : 'Loading')}
        </div>
      )}
      <div className={styles.hint}>{lang('ParvaneKeysBundleHint')}</div>

      <DeviceKeyDialog
        mode={isRenewOpen ? 'renew' : undefined}
        hasRoot={hasRoot}
        onClose={closeRenew}
        onDone={loadContents}
      />
    </div>
  );
};

function hasPart(contents: KeyBundleContents, part: typeof BUNDLE_ROWS[number]['part']) {
  switch (part) {
    case 'chats': return contents.hasChats;
    case 'files': return contents.hasFiles;
    case 'planner': return contents.hasPlanner;
    case 'health': return contents.hasHealth;
    default: return contents.hasMusic;
  }
}

export default memo(SettingsKeysBackup);
