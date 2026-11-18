import { APP_REVISION } from 'virtual:git-info';
import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { SettingsScreens } from '../../../types';

import {
  APP_NAME, BETA_CHANGELOG_URL, DEBUG, IS_BETA,
} from '../../../config';
import { selectTabState } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { getPromptInstall } from '../../../util/installPrompt';
import { getProfileServer } from './profile/profileFormat';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMultiClick from '../../../hooks/useMultiClick';

import ProfileIcon from './profile/ProfileIcon';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type StateProps = {
  canInstall: boolean;
};

const VERSION = IS_BETA ? `${APP_VERSION} Beta (${APP_REVISION})` : (DEBUG ? APP_REVISION : APP_VERSION);

// Parvane (spec 041 E3): «Профиль → О приложении» (доски `RpProfileA`, `ZdProfileX`) — версия, сервер,
// список изменений и установка. Пять нажатий на версию открывают экспериментальные настройки
const SettingsAbout = ({
  isActive, canInstall, onReset,
}: OwnProps & StateProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const server = getProfileServer();

  useHistoryBack({ isActive, onBack: onReset });

  const handleVersionClick = useMultiClick(5, () => {
    openSettingsScreen({ screen: SettingsScreens.Experimental });
  });

  const handleChangelogClick = useLastCallback(() => {
    window.open(BETA_CHANGELOG_URL, '_blank', 'noopener,noreferrer');
  });

  const handleInstallClick = useLastCallback(() => {
    void getPromptInstall()();
  });

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-about>
      <div className={styles.about}>
        <span className={styles.aboutLogo} aria-hidden>P</span>
        <div className={styles.aboutName}>{APP_NAME}</div>
        <div className={styles.aboutVersion} data-about-version onClick={handleVersionClick}>
          {lang('ParvaneAboutVersion', { version: VERSION })}
        </div>
      </div>
      <div className={styles.group}>
        {server && (
          <div className={styles.setRow}>
            <span className={styles.setTitle}>{lang('ParvaneAboutServer')}</span>
            <span className={styles.setValue}>{server}</span>
          </div>
        )}
        {IS_BETA && (
          <button type="button" className={rowClass} onClick={handleChangelogClick}>
            <span className={styles.setTitle}>{lang('MenuBetaChangelog')}</span>
            <ProfileIcon name="right" isSmall className={styles.menuChevron} />
          </button>
        )}
        {canInstall && (
          <button type="button" className={rowClass} onClick={handleInstallClick}>
            <span className={styles.setTitle}>{lang('MenuInstallApp')}</span>
            <ProfileIcon name="right" isSmall className={styles.menuChevron} />
          </button>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => ({
    canInstall: Boolean(selectTabState(global).canInstall),
  }),
)(SettingsAbout));
