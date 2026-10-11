import { memo } from '@teact';
import { getActions } from '../../global';

import type { ParvaneSection } from '../../util/parvaneSection';
import { LeftColumnContent, SettingsScreens } from '../../types';

import { ALL_FOLDER_ID } from '../../config';
import buildClassName from '../../util/buildClassName';
import { requestPlannerAdd, setParvaneSection } from '../../util/parvaneSection';

import useFlag from '../../hooks/useFlag';
import { useFolderManagerForUnreadCounters } from '../../hooks/useFolderManager';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import Menu from '../ui/Menu';
import MenuItem from '../ui/MenuItem';

import styles from './ParvaneTabBar.module.scss';

type OwnProps = {
  section: ParvaneSection;
  isSettingsOpen?: boolean;
};

const MAX_BADGE_COUNT = 99;

// Parvane: нижняя панель разделов на телефоне — Чаты, План, новая запись, Облако, Профиль.
// На компьютере разделы в боковой панели (`FoldersSidebar`)
const ParvaneTabBar = ({ section, isSettingsOpen }: OwnProps) => {
  const { openLeftColumnContent, openSettingsScreen } = getActions();

  const lang = useLang();
  const unreadCount = useFolderManagerForUnreadCounters()[ALL_FOLDER_ID]?.chatsCount || 0;

  const handleChatsClick = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.ChatList });
  });

  const handlePlannerClick = useLastCallback(() => {
    setParvaneSection('planner');
  });

  const handleCloudClick = useLastCallback(() => {
    setParvaneSection('cloud');
  });

  const handleProfileClick = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
    openSettingsScreen({ screen: SettingsScreens.Main });
  });

  const isChatsActive = section === 'messenger' && !isSettingsOpen;
  // «+» на списке чатов — меню «новое сообщение / группа / канал / запись в план» (вместо карандаша
  // Telegram); в остальных разделах — сразу запись в «План»
  const [isAddMenuOpen, openAddMenu, closeAddMenu] = useFlag();

  const handleAddClick = useLastCallback(() => {
    if (isChatsActive) openAddMenu();
    else requestPlannerAdd();
  });

  const handleNewMessage = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
  });

  const handleNewGroup = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.NewGroupStep1 });
  });

  const handleNewChannel = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.NewChannelStep1 });
  });

  const isProfileActive = section === 'messenger' && isSettingsOpen;

  return (
    <nav className={styles.root} aria-label={lang('ParvaneSections')}>
      <button
        type="button"
        className={buildClassName(styles.tab, isChatsActive && styles.tabActive)}
        aria-current={isChatsActive ? 'page' : undefined}
        onClick={handleChatsClick}
      >
        <span className={styles.iconWrap}>
          <Icon name="folder-tabs-chats" className={styles.icon} />
          {Boolean(unreadCount) && (
            <span className={styles.badge}>
              {unreadCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : unreadCount}
            </span>
          )}
        </span>
        <span className={styles.title}>{lang('ParvaneSectionMessenger')}</span>
      </button>
      <button
        type="button"
        className={buildClassName(styles.tab, section === 'planner' && styles.tabActive)}
        aria-current={section === 'planner' ? 'page' : undefined}
        onClick={handlePlannerClick}
      >
        <Icon name="calendar" className={styles.icon} />
        <span className={styles.title}>{lang('ParvaneSectionPlanner')}</span>
      </button>
      <button
        type="button"
        className={styles.addButton}
        aria-label={lang('ParvaneTabBarAdd')}
        aria-haspopup={isChatsActive ? 'menu' : undefined}
        onClick={handleAddClick}
      >
        <Icon name="add" className={styles.addIcon} />
      </button>
      <Menu
        isOpen={isAddMenuOpen}
        className={styles.addMenu}
        positionX="left"
        positionY="bottom"
        autoClose
        onClose={closeAddMenu}
      >
        <MenuItem icon="user" onClick={handleNewMessage}>{lang('NewMessageTitle')}</MenuItem>
        <MenuItem icon="group" onClick={handleNewGroup}>{lang('NewGroup')}</MenuItem>
        <MenuItem icon="channel" onClick={handleNewChannel}>{lang('NewChannel')}</MenuItem>
        <MenuItem icon="calendar" onClick={requestPlannerAdd}>{lang('ParvaneTabBarPlanEntry')}</MenuItem>
      </Menu>
      <button
        type="button"
        className={buildClassName(styles.tab, section === 'cloud' && styles.tabActive)}
        aria-current={section === 'cloud' ? 'page' : undefined}
        onClick={handleCloudClick}
      >
        <Icon name="folder" className={styles.icon} />
        <span className={styles.title}>{lang('ParvaneSectionKnowledge')}</span>
      </button>
      <button
        type="button"
        className={buildClassName(styles.tab, isProfileActive && styles.tabActive)}
        aria-current={isProfileActive ? 'page' : undefined}
        onClick={handleProfileClick}
      >
        <Icon name="user" className={styles.icon} />
        <span className={styles.title}>{lang('ParvaneTabBarProfile')}</span>
      </button>
    </nav>
  );
};

export default memo(ParvaneTabBar);
