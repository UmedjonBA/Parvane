import { memo, useMemo } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ApiUser } from '../../../../api/types';
import type { GlobalState } from '../../../../global/types';
import { SettingsScreens } from '../../../../types';

import { selectUser } from '../../../../global/selectors';
import { IS_MULTIACCOUNT_SUPPORTED } from '../../../../util/browser/globalEnvironment';
import buildClassName from '../../../../util/buildClassName';
import { formatPastTimeShort } from '../../../../util/dates/oldDateFormat';
import getSessionAppLine from '../helpers/getSessionAppLine';
import { getDeviceIcon } from './profileFormat';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import SettingsAccounts from '../SettingsAccounts';
import ProfileAppearance from './ProfileAppearance';
import ProfileHead from './ProfileHead';
import ProfileIcon from './ProfileIcon';

import styles from './Profile.module.scss';

type StateProps = {
  currentUser?: ApiUser;
  sessionsByHash: GlobalState['activeSessions']['byHash'];
  sessionHashes: string[];
};

// Parvane (spec 041 E3): «Обзор» — главный экран «Профиля» на компьютере (доска `DeskProfile`): аккаунт,
// «Избранное / Контакты / Архив», оформление и устройства. Завершение сеанса требует пароль, поэтому
// список устройств здесь только показывает их, действия — на экране «Устройства и аккаунт»
const ProfileOverview = ({ currentUser, sessionsByHash, sessionHashes }: StateProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();

  const ordered = useMemo(() => {
    return sessionHashes.map((hash) => sessionsByHash[hash]).filter(Boolean)
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
  }, [sessionsByHash, sessionHashes]);

  const handleOpenDevices = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.ActiveSessions });
  });

  return (
    <div className={buildClassName(styles.overview, 'settings-main-scroll', 'custom-scroll')} data-profile-overview>
      <ProfileHead variant="desk" />
      {IS_MULTIACCOUNT_SUPPORTED && currentUser && <SettingsAccounts currentUser={currentUser} />}
      <div className={styles.overviewGrid}>
        <section className={styles.card} data-overview-card="appearance">
          <div className={styles.cardCaption}>{lang('ParvaneAppearance')}</div>
          <ProfileAppearance part="all" />
        </section>
        <section className={styles.card} data-overview-card="devices">
          <div className={styles.cardCaption}>{lang('ParvaneProfileDevicesCount', { count: ordered.length })}</div>
          {ordered.map((session) => (
            <div key={session.hash} className={styles.device}>
              <ProfileIcon name={getDeviceIcon(session)} className={styles.muted} />
              <div className={styles.deviceText}>
                <div className={styles.deviceName}>
                  {[session.deviceModel, session.platform].filter(Boolean).join(' · ')}
                </div>
                <div className={styles.deviceHint}>
                  {session.isCurrent
                    ? lang('ParvaneProfileThisDevice')
                    : [getSessionAppLine(lang, session), formatPastTimeShort(oldLang, session.dateActive * 1000)]
                      .filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          ))}
          <span className={styles.cardSpacer} />
          <button type="button" className={styles.cardLink} data-overview-devices onClick={handleOpenDevices}>
            {lang('ParvaneProfileDevices')}
            <ProfileIcon name="right" isSmall />
          </button>
        </section>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const { currentUserId, activeSessions: { byHash, orderedHashes } } = global;
    return {
      currentUser: currentUserId ? selectUser(global, currentUserId) : undefined,
      sessionsByHash: byHash,
      sessionHashes: orderedHashes,
    };
  },
)(ProfileOverview));
