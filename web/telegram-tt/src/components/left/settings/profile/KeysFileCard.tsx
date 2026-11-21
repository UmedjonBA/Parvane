import { memo } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';
import { formatBackupDate } from './profileStatus';

import useLang from '../../../../hooks/useLang';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from './Profile.module.scss';

type OwnProps = {
  savedAt?: number;
  isStale?: boolean;
  onSave?: NoneToVoidFunction;
  onRestore?: NoneToVoidFunction;
};

// Карточка файла копии ключей (доски `RpProfileB`, `DkSettingsB`): точка состояния, «Копия сохранена 2 ноября», «с тех
// пор ключи не менялись» либо «ключи менялись — сохраните новую», пояснение и кнопки «Сохранить новую / Восстановить»
const KeysFileCard = ({
  savedAt, isStale, onSave, onRestore,
}: OwnProps) => {
  const lang = useLang();
  const state = !savedAt ? 'none' : isStale ? 'stale' : 'ok';
  const dotClass = state === 'ok' ? styles.statusDotOk : state === 'stale' ? styles.statusDotStale : undefined;

  return (
    <div className={styles.statusCard} data-keys-file-card={state} data-keys-saved-at={savedAt || undefined}>
      <div className={styles.statusHead}>
        <span className={buildClassName(styles.statusDot, dotClass)} aria-hidden />
        <span className={styles.statusTitle}>
          {savedAt
            ? lang('ParvaneKeysBackupSavedAt', { date: formatBackupDate(savedAt, lang.code) })
            : lang('ParvaneKeysBackupNone')}
        </span>
      </div>
      {Boolean(savedAt) && isStale !== undefined && (
        <div className={styles.statusSub}>
          {lang(isStale ? 'ParvaneKeysFileStale' : 'ParvaneKeysFileFresh')}
        </div>
      )}
      <div className={styles.statusText}>{lang('ParvaneKeysBackupHint')}</div>
      {onSave && onRestore && (
        <div className={styles.statusButtons}>
          <button type="button" className={kit.btn} data-keys-action="save" onClick={onSave}>
            {lang('ParvaneKeysFileSaveNew')}
          </button>
          <button type="button" className={kit.btn} data-keys-action="restore" onClick={onRestore}>
            {lang('ParvaneKeysFileRestore')}
          </button>
        </div>
      )}
    </div>
  );
};

export default memo(KeysFileCard);
