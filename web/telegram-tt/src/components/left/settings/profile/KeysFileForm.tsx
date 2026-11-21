import type { ChangeEvent } from 'react';
import { memo, useLayoutEffect, useMemo, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { PvSegmentItem } from '../../../parvane/notes/PvSegment';
import type { KeysFileTab } from './profileRequests';

import buildClassName from '../../../../util/buildClassName';
import { openSystemFilesDialog } from '../../../../util/systemFilesDialog';
import { KEYS_FILE_PASSWORD_MIN, restoreKeysFile, saveKeysFile } from './keysFile';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import PvSegment from '../../../parvane/notes/PvSegment';
import SecretForm from '../../../ui/SecretForm';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from './Profile.module.scss';

type OwnProps = {
  user?: string;
  tab: KeysFileTab;
  onTabChange: (tab: KeysFileTab) => void;
  onDone: NoneToVoidFunction;
};

// Форма файла копии ключей (доска `RpProfileB`): вкладки «Сохранить новую · Восстановить». Сохранение — пароль копии и
// повтор (не короче 8 знаков, «Пароли не совпадают»), «Куда сохранить · Загрузки», «Сохранить файл копии»;
// восстановление — выбор файла и пароль. Вместо прежнего `window.prompt`: он не работает в части установленных PWA и
// не давал повторить пароль
const KeysFileForm = ({
  user, tab, onTabChange, onDone,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [file, setFile] = useState<File>();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Смена вкладки начинает форму заново: пароль от сохранения не должен уйти в восстановление
  useLayoutEffect(() => {
    setPassword('');
    setRepeat('');
    setFile(undefined);
    setError(undefined);
  }, [tab]);

  const tabs = useMemo<PvSegmentItem<KeysFileTab>[]>(() => [
    { value: 'save', label: lang('ParvaneKeysFileSaveNew') },
    { value: 'restore', label: lang('ParvaneKeysFileRestore') },
  ], [lang]);

  const isShort = password.length > 0 && password.length < KEYS_FILE_PASSWORD_MIN;
  const isMismatch = repeat.length > 0 && repeat !== password;
  const canSave = password.length >= KEYS_FILE_PASSWORD_MIN && repeat === password && !isBusy;
  const canRestore = Boolean(file) && Boolean(password) && !isBusy;

  const handlePassword = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.currentTarget.value);
    setError(undefined);
  });

  const handleRepeat = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setRepeat(e.currentTarget.value);
  });

  const handlePickFile = useLastCallback(() => {
    openSystemFilesDialog('.json', (e) => {
      setFile((e.target as HTMLInputElement).files?.[0]);
      setError(undefined);
    }, true);
  });

  const handleSave = useLastCallback(async () => {
    if (!canSave) return;
    setIsBusy(true);
    const isSaved = await saveKeysFile(user, password);
    setIsBusy(false);
    if (!isSaved) {
      setError(oldLang('ParvaneKeysExportFailed'));
      return;
    }
    setPassword('');
    setRepeat('');
    showNotification({ message: oldLang('ParvaneKeysExported') });
    onDone();
  });

  const handleRestore = useLastCallback(async () => {
    if (!canRestore) return;
    setIsBusy(true);
    if (!file) return;
    const isRestored = await restoreKeysFile(file, password);
    setIsBusy(false);
    if (!isRestored) {
      setError(oldLang('ParvaneKeysImportFailed'));
      return;
    }
    setPassword('');
    setFile(undefined);
    showNotification({ message: oldLang('ParvaneKeysImported') });
    onDone();
  });

  return (
    <div className={styles.keysForm} data-keys-file-form={tab}>
      <PvSegment
        items={tabs}
        value={tab}
        label={lang('ParvaneProfileKeys')}
        isTabs
        className={styles.modeSegment}
        onChange={onTabChange}
      />
      <SecretForm className={styles.fieldForm}>
        {tab === 'restore' && (
          <button
            type="button"
            className={buildClassName(styles.setRow, styles.setRowAction, styles.fileRow)}
            data-keys-file-pick
            onClick={handlePickFile}
          >
            <span className={styles.setTitle}>{lang('ParvaneKeysFileChoose')}</span>
            <span className={styles.setValue}>{file?.name || lang('ParvaneKeysFileNotChosen')}</span>
          </button>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{lang('ParvaneKeysFilePassword')}</span>
          <input
            type="password"
            className={buildClassName('form-control', isShort && tab === 'save' && 'error')}
            autoComplete="new-password"
            value={password}
            disabled={isBusy}
            data-keys-password
            onChange={handlePassword}
          />
        </label>
        {tab === 'save' && (
          <>
            <div className={styles.fieldHint}>{lang('ParvaneKeysFilePasswordRule')}</div>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{lang('ParvaneKeysFileRepeat')}</span>
              <input
                type="password"
                className={buildClassName('form-control', isMismatch && 'error')}
                autoComplete="new-password"
                value={repeat}
                disabled={isBusy}
                aria-invalid={isMismatch || undefined}
                data-keys-password-repeat
                onChange={handleRepeat}
              />
            </label>
            {isMismatch && (
              <div className={styles.fieldError} data-keys-error="mismatch">{lang('ParvanePasswordMismatch')}</div>
            )}
            <div className={buildClassName(styles.setRow, styles.fileRow)}>
              <span className={styles.setTitle}>{lang('ParvaneKeysFileWhere')}</span>
              <span className={buildClassName(styles.setValue, styles.setValueWord)}>
                {lang('ParvaneKeysFileDownloads')}
              </span>
            </div>
          </>
        )}
        {error && <div className={styles.fieldError} data-keys-error="failed">{error}</div>}
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
          disabled={tab === 'save' ? !canSave : !canRestore}
          data-keys-submit={tab}
          onClick={tab === 'save' ? handleSave : handleRestore}
        >
          {lang(tab === 'save' ? 'ParvaneKeysFileSaveButton' : 'ParvaneKeysFileRestoreButton')}
        </button>
        {tab === 'save' && <div className={styles.fieldHint}>{lang('ParvaneKeysFileForgetHint')}</div>}
      </SecretForm>
    </div>
  );
};

export default memo(KeysFileForm);
