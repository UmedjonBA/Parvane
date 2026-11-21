import { APP_REVISION } from 'virtual:git-info';
import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { SettingsScreens } from '../../../types';

import { APP_NAME } from '../../../config';
import { selectTabState } from '../../../global/selectors';
import {
  applyAppUpdate, checkAppUpdate, getIsAutoUpdateOn, getUpdateCheckedAt, setAutoUpdateOn,
} from '../../../util/appUpdate';
import buildClassName from '../../../util/buildClassName';
import { formatDateAtTime } from '../../../util/dates/oldDateFormat';
import { getPromptInstall } from '../../../util/installPrompt';
import { PARVANE_BUG_REPORT_ADDRESS } from '../../../util/parvaneDiag';
import { callApi } from '../../../api/gramjs';
import { getProfileServer } from './profile/profileFormat';

import useAppLayout from '../../../hooks/useAppLayout';
import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMultiClick from '../../../hooks/useMultiClick';
import useOldLang from '../../../hooks/useOldLang';

import HotkeysDialog from '../../main/HotkeysDialog';
import LicensesDialog from './profile/LicensesDialog';
import ProfileIcon from './profile/ProfileIcon';
import ProfileSwitchRow from './profile/ProfileSwitchRow';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type StateProps = {
  canInstall: boolean;
  isUpdateAvailable?: boolean;
};

// Исходный код Parvane и журнал изменений — история коммитов того же хранилища
const SOURCE_URL = 'https://github.com/UmedjonBA/Parvane';
const CHANGELOG_URL = `${SOURCE_URL}/commits/master`;
const callParvane = callApi as unknown as (method: string) => Promise<unknown>;

// Parvane (доски `RpProfileA`, `ZdProfileX`): «Профиль → О приложении» — версия и сборка, сервер и его версия (версия
// протокола из описателя сервера), «Обновление» (проверка `version.txt`, «Обновить» — перезагрузка в новую сборку),
// «Обновлять автоматически», «Что нового», «Исходный код», «Лицензии», «Горячие клавиши · Ctrl+/», адрес
// администратора сервера (туда же уходят отчёты об ошибках). Пять нажатий на версию — экспериментальные настройки
const SettingsAbout = ({
  isActive, canInstall, isUpdateAvailable, onReset,
}: OwnProps & StateProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const { isDesktop } = useAppLayout();
  const server = getProfileServer();
  const [serverVersion, setServerVersion] = useState<string>();
  const [checkedAt, setCheckedAt] = useState(getUpdateCheckedAt);
  const [isChecking, setIsChecking] = useState(false);
  const [isAutoUpdate, setIsAutoUpdate] = useState(getIsAutoUpdateOn);
  const [isLicensesOpen, openLicenses, closeLicenses] = useFlag();
  const [isHotkeysOpen, openHotkeys, closeHotkeys] = useFlag();

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (!isActive) return;
    void callParvane('parvaneServerVersion').then((version) => setServerVersion(version as string | undefined));
  }, [isActive]);

  const handleVersionClick = useMultiClick(5, () => {
    openSettingsScreen({ screen: SettingsScreens.Experimental });
  });

  const handleCheck = useLastCallback(async () => {
    setIsChecking(true);
    await checkAppUpdate();
    setCheckedAt(getUpdateCheckedAt());
    setIsChecking(false);
  });

  const handleAutoUpdate = useLastCallback((isOn: boolean) => {
    setAutoUpdateOn(isOn);
    setIsAutoUpdate(isOn);
  });

  const handleOpenUrl = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    window.open(e.currentTarget.dataset.url, '_blank', 'noopener,noreferrer');
  });

  const handleInstallClick = useLastCallback(() => {
    void getPromptInstall()();
  });

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);
  const adminAddress = PARVANE_BUG_REPORT_ADDRESS.includes('@') || !server
    ? PARVANE_BUG_REPORT_ADDRESS : `${PARVANE_BUG_REPORT_ADDRESS}@${server}`;

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-about>
      <div className={styles.about}>
        <span className={styles.aboutLogo} aria-hidden>P</span>
        <div className={styles.aboutName}>{APP_NAME}</div>
        <div className={styles.aboutVersion} data-about-version onClick={handleVersionClick}>
          {lang('ParvaneAboutVersionBuild', { version: APP_VERSION, build: APP_REVISION })}
        </div>
      </div>
      <div className={styles.group}>
        {isDesktop && (
          <div className={styles.setRow}>
            <span className={styles.setTitle}>{lang('ParvaneAboutAppVersion')}</span>
            <span className={styles.setValue}>{APP_VERSION}</span>
          </div>
        )}
        {server && (
          <div className={styles.setRow}>
            <span className={styles.setTitle}>{lang('ParvaneAboutServer')}</span>
            <span className={styles.setValue}>{server}</span>
          </div>
        )}
        <div className={styles.setRow} data-about-server-version={serverVersion}>
          <span className={styles.setTitle}>{lang('ParvaneAboutServerVersion')}</span>
          <span className={styles.setValue}>
            {serverVersion ? lang('ParvaneAboutProtocol', { version: serverVersion }) : '—'}
          </span>
        </div>
      </div>

      <div className={styles.caption}>{lang('ParvaneAboutUpdate')}</div>
      <div className={styles.group} data-about-update={isUpdateAvailable ? 'available' : 'none'}>
        <div className={styles.setRow}>
          <span className={styles.setText}>
            <span className={styles.setTitle}>
              {lang(isUpdateAvailable ? 'ParvaneAboutUpdateAvailable' : 'ParvaneAboutUpdateNone')}
            </span>
            <span className={styles.setHint}>
              {isUpdateAvailable ? lang('ParvaneAboutUpdateFrom')
                : checkedAt ? lang('ParvaneAboutUpdateChecked', { when: formatDateAtTime(oldLang, checkedAt) })
                  : lang('ParvaneAboutUpdateNever')}
            </span>
          </span>
          {isUpdateAvailable ? (
            <button type="button" className={styles.chip} data-about-action="update" onClick={applyAppUpdate}>
              {lang('ParvaneAboutUpdateApply')}
            </button>
          ) : (
            <button
              type="button"
              className={styles.chip}
              disabled={isChecking}
              data-about-action="check"
              onClick={handleCheck}
            >
              {lang('ParvaneAboutUpdateCheck')}
            </button>
          )}
        </div>
        <ProfileSwitchRow
          title={lang('ParvaneAboutAutoUpdate')}
          hint={lang('ParvaneAboutAutoUpdateHint')}
          isOn={isAutoUpdate}
          onChange={handleAutoUpdate}
          data-about-auto-update
        />
      </div>

      <div className={styles.group}>
        <button
          type="button"
          className={rowClass}
          data-about-row="changelog"
          data-url={CHANGELOG_URL}
          onClick={handleOpenUrl}
        >
          <span className={styles.setText}>
            <span className={styles.setTitle}>{lang('ParvaneAboutWhatsNew')}</span>
            <span className={styles.setHint}>{lang('ParvaneAboutWhatsNewHint')}</span>
          </span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        <button
          type="button"
          className={rowClass}
          data-about-row="source"
          data-url={SOURCE_URL}
          onClick={handleOpenUrl}
        >
          <span className={styles.setTitle}>{lang('ParvaneAboutSource')}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        <button type="button" className={rowClass} data-about-row="licenses" onClick={openLicenses}>
          <span className={styles.setTitle}>{lang('ParvaneAboutLicenses')}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        {isDesktop && (
          <button type="button" className={rowClass} data-about-row="hotkeys" onClick={openHotkeys}>
            <span className={styles.setTitle}>{lang('ParvaneAboutHotkeys')}</span>
            <span className={styles.setValue}>Ctrl+/</span>
          </button>
        )}
        {canInstall && (
          <button type="button" className={rowClass} onClick={handleInstallClick}>
            <span className={styles.setTitle}>{lang('MenuInstallApp')}</span>
            <ProfileIcon name="right" isSmall className={styles.menuChevron} />
          </button>
        )}
      </div>
      <div className={styles.hint} data-about-admin>{lang('ParvaneAboutAdmin', { address: adminAddress })}</div>

      <LicensesDialog isOpen={isLicensesOpen} onClose={closeLicenses} />
      <HotkeysDialog isOpen={isHotkeysOpen} onClose={closeHotkeys} />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => ({
    canInstall: Boolean(selectTabState(global).canInstall),
    isUpdateAvailable: global.isAppUpdateAvailable,
  }),
)(SettingsAbout));
