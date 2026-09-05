import type { FC } from '../../../lib/teact/teact';
import { memo, useEffect } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { SettingsScreens } from '../../../types';

import buildClassName from '../../../util/buildClassName';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';

import ChatExtra from '../../common/profile/ChatExtra';
import ProfileInfo from '../../common/profile/ProfileInfo';
import Island from '../../gili/layout/Island';
import ListItem from '../../ui/ListItem';

import styles from './SettingsMain.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  sessionCount: number;
  currentUserId?: string;
};

const SettingsMain: FC<OwnProps & StateProps> = ({
  isActive,
  currentUserId,
  sessionCount,
  onReset,
}) => {
  const {
    loadAuthorizations,
    loadMoreProfilePhotos,
    openSettingsScreen,
  } = getActions();

  const lang = useLang();

  useEffect(() => {
    if (currentUserId) {
      loadMoreProfilePhotos({ peerId: currentUserId, isPreload: true });
    }
  }, [currentUserId]);

  // Parvane: устройства могли добавиться/отозваться после старта приложения —
  // перечитываем список при каждом заходе в настройки
  useEffect(() => {
    if (isActive) {
      loadAuthorizations();
    }
  }, [isActive]);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  return (
    <div className={buildClassName(styles.root, 'settings-main-scroll', 'custom-scroll')}>
      <div className={styles.selfProfile}>
        {currentUserId && (
          <ProfileInfo
            peerId={currentUserId}
            isActive={Boolean(isActive)}
            canPlayVideo={Boolean(isActive)}
            isForSettings
          />
        )}
        {currentUserId && (
          <ChatExtra
            chatOrUserId={currentUserId}
            isInSettings
          />
        )}
      </div>
      <div className={styles.menuSection}>
        <Island>
          <ListItem
            icon="settings"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.General })}
          >
            {lang('TelegramGeneralSettingsViewController')}
          </ListItem>
          <ListItem
            icon="animations"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.Performance })}
          >
            {lang('MenuAnimations')}
          </ListItem>
          <ListItem
            icon="unmute"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.Notifications })}
          >
            {lang('Notifications')}
          </ListItem>
          <ListItem
            icon="data"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.DataStorage })}
          >
            {lang('DataSettings')}
          </ListItem>
          <ListItem
            icon="lock"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.Privacy })}
          >
            {lang('PrivacySettings')}
          </ListItem>
          <ListItem
            icon="folder"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.Folders })}
          >
            {lang('Filters')}
          </ListItem>
          <ListItem
            icon="active-sessions"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.ActiveSessions })}
          >
            {lang('Devices')}
          </ListItem>
          <ListItem
            icon="language"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.Language })}
          >
            {lang('Language')}
            <span className="settings-item__current-value">{lang.languageInfo.nativeName}</span>
          </ListItem>
          <ListItem
            icon="stickers"
            narrow
            onClick={() => openSettingsScreen({ screen: SettingsScreens.Stickers })}
          >
            {lang('MenuStickers')}
          </ListItem>
        </Island>
        {/* Parvane: Premium/Stars/Gram/подарки и справка Telegram (Ask a
            Question, FAQ, Privacy Policy) — инфраструктура Telegram, скрыты */}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { currentUserId } = global;

    return {
      sessionCount: global.activeSessions.orderedHashes.length,
      currentUserId,
    };
  },
)(SettingsMain));
