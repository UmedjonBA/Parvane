import { memo, useMemo, useState } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ApiUser } from '../../../../api/types';
import type { GlobalState } from '../../../../global/types';
import { SettingsScreens } from '../../../../types';

import { selectUser } from '../../../../global/selectors';
import { IS_MULTIACCOUNT_SUPPORTED } from '../../../../util/browser/globalEnvironment';
import buildClassName from '../../../../util/buildClassName';
import { formatPastTimeShort } from '../../../../util/dates/oldDateFormat';
import { getDeviceIcon } from './profileFormat';
import { formatBackupDate } from './profileStatus';
import useKeysFileStatus from './useKeysFileStatus';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import SettingsAccounts from '../SettingsAccounts';
import SettingsActiveSession from '../SettingsActiveSession';
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
// «Избранное / Контакты / Архив», оформление и устройства: у чужих — «Завершить» (то же окно сеанса с паролем, что на
// экране «Устройства и аккаунт»), внизу — «Копия ключей сохранена … · Открыть»
const ProfileOverview = ({ currentUser, sessionsByHash, sessionHashes }: StateProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const keysFile = useKeysFileStatus(true);
  const [openedSessionHash, setOpenedSessionHash] = useState<string>();

  const ordered = useMemo(() => {
    return sessionHashes.map((hash) => sessionsByHash[hash]).filter(Boolean)
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
  }, [sessionsByHash, sessionHashes]);

  const handleOpenKeys = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.ParvaneKeysBackup });
  });

  const handleTerminate = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setOpenedSessionHash(e.currentTarget.dataset.sessionHash);
  });

  const closeSession = useLastCallback(() => setOpenedSessionHash(undefined));

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
                    : lang('ParvaneDeviceSeen', { time: formatPastTimeShort(oldLang, session.dateActive * 1000) })}
                </div>
              </div>
              {!session.isCurrent && (
                <button
                  type="button"
                  className={buildClassName(styles.chip, styles.chipDanger)}
                  data-overview-terminate={session.hash}
                  data-session-hash={session.hash}
                  onClick={handleTerminate}
                >
                  {lang('ParvaneOverviewTerminate')}
                </button>
              )}
            </div>
          ))}
          <span className={styles.cardSpacer} />
          <div className={styles.cardFooter} data-overview-keys={keysFile.savedAt ? 'saved' : 'none'}>
            <span className={styles.cardFooterText}>
              {keysFile.savedAt
                ? lang('ParvaneKeysBackupSavedAt', { date: formatBackupDate(keysFile.savedAt, lang.code) })
                : lang('ParvaneKeysBackupNone')}
            </span>
            <button type="button" className={styles.cardLink} data-overview-keys-open onClick={handleOpenKeys}>
              {lang('ParvaneOverviewOpen')}
              <ProfileIcon name="right" isSmall />
            </button>
          </div>
        </section>
      </div>
      <SettingsActiveSession isOpen={Boolean(openedSessionHash)} hash={openedSessionHash} onClose={closeSession} />
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
