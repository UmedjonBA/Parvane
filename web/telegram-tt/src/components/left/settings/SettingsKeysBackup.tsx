import { memo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import buildClassName from '../../../util/buildClassName';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';
import { formatBackupDate, getKeysBackupSavedAt, markKeysBackupSaved } from './profile/profileStatus';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import ProfileIcon from './profile/ProfileIcon';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;
const KEYS_PASSWORD_MIN_LENGTH = 8;

// Parvane (spec 041 E3): «Профиль → Копия ключей» (доски `RpProfileB`, `ZdProfileX`) — файл под паролем с
// ключами и историей устройства. Прежде обе строки стояли на экране «Конфиденциальность»
const SettingsKeysBackup = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();

  const userId = getGlobal().currentUserId;
  const [savedAt, setSavedAt] = useState(() => getKeysBackupSavedAt(userId));

  useHistoryBack({ isActive, onBack: onReset });

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
    </div>
  );
};

export default memo(SettingsKeysBackup);
