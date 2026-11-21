import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { KeysFileTab } from './profile/profileRequests';

import buildClassName from '../../../util/buildClassName';
import { formatDateAtTime } from '../../../util/dates/oldDateFormat';
import { callApi } from '../../../api/gramjs';
import useKeysFileStatus from './profile/useKeysFileStatus';

import useAppLayout from '../../../hooks/useAppLayout';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import { DeviceKeyDialog } from './devices/DeviceDialogs';
import KeysBundleOffDialog from './KeysBundleOffDialog';
import KeysFileCard from './profile/KeysFileCard';
import KeysFileForm from './profile/KeysFileForm';

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
  isOff: boolean;
  updatedAt?: number;
  keyAt?: number;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
// «Что в копии»: строка — признак состава и её название
const BUNDLE_ROWS = [
  { part: 'chats', key: 'ParvaneKeysBundleChats' },
  { part: 'files', key: 'ParvaneKeysBundleFiles' },
  { part: 'planner', key: 'ParvaneKeysBundlePlanner' },
  { part: 'health', key: 'ParvaneKeysBundleHealth' },
  { part: 'music', key: 'ParvaneKeysBundleMusic' },
] as const;

// Parvane (spec 041 E3): «Профиль → Копия ключей». Компьютер — доска `ZdProfileX`: состояние копии ключей аккаунта
// («включена · обновлена сегодня в 14:02»), «Ключ восстановления» (дата создания, «Создать новый ключ»), «Что в копии»,
// «Выключить копию»; файл копии на компьютере — на «Данных и памяти» (`DkSettingsB`). Телефон — доска `RpProfileB`:
// карточка файла копии и форма «Сохранить новую · Восстановить» сверху, ниже то же про копию аккаунта
const SettingsKeysBackup = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const { isDesktop } = useAppLayout();
  const fileStatus = useKeysFileStatus(isActive);
  const [fileTab, setFileTab] = useState<KeysFileTab>('save');

  const [isRenewOpen, setIsRenewOpen] = useState(false);
  const [isOffOpen, setIsOffOpen] = useState(false);
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
  const openOff = useLastCallback(() => setIsOffOpen(true));
  const closeOff = useLastCallback(() => setIsOffOpen(false));

  const handleEnable = useLastCallback(async () => {
    const isEnabled = await callParvane('parvaneEnableKeyBundle') as boolean | undefined;
    showNotification({ message: lang(isEnabled ? 'ParvaneKeysOnDone' : 'ParvaneKeysOnFailed') });
    void loadContents();
  });

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);
  const bundleState = contents ? (contents.isOff ? 'off' : 'on') : 'none';
  const keyDate = contents?.keyAt
    ? new Intl.DateTimeFormat(lang.code, { day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(contents.keyAt))
    : undefined;

  function renderBundleTitle() {
    if (!isContentsLoaded) return lang('Loading');
    if (!contents) return lang('ParvaneKeysBundleNone');
    if (contents.isOff) return lang('ParvaneKeysOffState');
    return contents.updatedAt
      ? lang('ParvaneKeysBundleOnAt', { when: formatDateAtTime(oldLang, contents.updatedAt) })
      : lang('ParvaneKeysBundleOn');
  }

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-keys>
      {!isDesktop && (
        <>
          <KeysFileCard savedAt={fileStatus.savedAt} isStale={fileStatus.isStale} />
          <KeysFileForm user={fileStatus.user} tab={fileTab} onTabChange={setFileTab} onDone={fileStatus.refresh} />
          <div className={styles.caption}>{lang('ParvaneKeysAccountCaption')}</div>
        </>
      )}
      {isDesktop && <div className={styles.hint}>{lang('ParvaneKeysScreenHint')}</div>}
      <div
        className={styles.statusCard}
        data-keys-bundle-state={bundleState}
        data-keys-bundle-none={isContentsLoaded && !contents ? true : undefined}
        data-keys-bundle-off={contents?.isOff || undefined}
      >
        <div className={styles.statusHead}>
          <span
            className={buildClassName(styles.statusDot, bundleState === 'on' && styles.statusDotOk)}
            aria-hidden
          />
          <span className={styles.statusTitle}>{renderBundleTitle()}</span>
        </div>
        {contents?.isOff && (
          <button type="button" className={styles.statusLink} data-keys-action="bundle-on" onClick={handleEnable}>
            {lang('ParvaneKeysOnAction')}
          </button>
        )}
        {contents?.isOff && <div className={styles.statusText}>{lang('ParvaneKeysOnHint')}</div>}
      </div>

      <div className={styles.caption}>{lang('ParvaneRecoveryKeyCaption')}</div>
      <div className={styles.group}>
        {keyDate && (
          <div className={styles.setRow} data-keys-key-created>
            <span className={styles.setTitle}>{lang('ParvaneRecoveryKeyCreated')}</span>
            <span className={styles.setValue}>{keyDate}</span>
          </div>
        )}
        <div className={styles.setRow}>
          <span className={styles.setText}>
            <span className={styles.setTitle}>{lang('ParvaneRecoveryKeyRenew')}</span>
            <span className={styles.setHint}>{lang('ParvaneRecoveryKeyRenewHint')}</span>
          </span>
          <button type="button" className={styles.chip} data-keys-action="renew" onClick={openRenew}>
            {lang('ParvaneRecoveryKeyCreate')}
          </button>
        </div>
      </div>
      <div className={styles.hint}>{lang('ParvaneRecoveryKeyAbout')}</div>

      {contents && !contents.isOff && (
        <>
          <div className={styles.caption}>{lang('ParvaneKeysBundleWhat')}</div>
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
          <div className={styles.group}>
            <button
              type="button"
              className={buildClassName(rowClass, styles.danger)}
              data-keys-action="bundle-off"
              onClick={openOff}
            >
              <span className={styles.setTitle}>{lang('ParvaneKeysOffAction')}</span>
            </button>
          </div>
        </>
      )}
      <div className={styles.hint}>{lang('ParvaneKeysBundleHint')}</div>

      <DeviceKeyDialog
        mode={isRenewOpen ? 'renew' : undefined}
        hasRoot={hasRoot}
        onClose={closeRenew}
        onDone={loadContents}
      />
      <KeysBundleOffDialog isOpen={isOffOpen} onClose={closeOff} onDone={loadContents} />
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
