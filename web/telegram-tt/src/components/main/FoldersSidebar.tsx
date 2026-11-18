import { memo } from '@teact';
import { getActions, withGlobal } from '../../global';

import type { ParvaneModuleId } from '../../util/parvaneModules';
import { LeftColumnContent } from '../../types';

import { ALL_FOLDER_ID } from '../../config';
import { selectLeftColumnContentKey } from '../../global/selectors';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import {
  getParvaneSection, requestHealthAdd, requestModuleAdd, requestPlannerAdd, setParvaneSection,
} from '../../util/parvaneSection';
import { openPalette } from '../parvane/palette/paletteOpen';
import {
  getActiveModule, MODULE_ICONS, MODULE_TITLE_KEYS, openModule,
} from './parvaneModuleNav';

import useDerivedState from '../../hooks/useDerivedState';
import useFlag from '../../hooks/useFlag';
import { useFolderManagerForUnreadCounters } from '../../hooks/useFolderManager';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useParvaneModules from '../../hooks/useParvaneModules';

import MusicMiniPlayer from '../parvane/music/MusicMiniPlayer';
import Menu from '../ui/Menu';
import MenuItem from '../ui/MenuItem';
import ParvaneIcon from './ParvaneIcon';

import styles from './FoldersSidebar.module.scss';

type StateProps = {
  // Открыты настройки: в панели выделен «Профиль», а не «Чаты»
  isSettingsOpen: boolean;
};

type OwnProps = {
  isActive: boolean;
  isMobile?: boolean;
  // Прежнее положение папок «слева»: папки теперь всегда полосой над списком чатов, значение не читается
  withFolders?: boolean;
};

const MAX_BADGE_COUNT = 99;

// Parvane: боковая панель модулей на компьютере. Сверху знак и модули в порядке пользователя
// (`parvaneModules`), внизу общий поиск (палитра Ctrl+K) и «+». «Профиль» — такой же модуль, как остальные.
// Папок чатов здесь нет — они над списком чатов.
// На телефоне модули в нижней ленте (`ParvaneTabBar`)
const FoldersSidebar = ({ isActive, isSettingsOpen }: OwnProps & StateProps) => {
  const { openLeftColumnContent } = getActions();

  const lang = useLang();

  const section = useDerivedState(getParvaneSection);
  const { enabled: modules } = useParvaneModules();
  const unreadCount = useFolderManagerForUnreadCounters()[ALL_FOLDER_ID]?.chatsCount || 0;

  const activeModule = getActiveModule(section, isSettingsOpen);
  const [isAddMenuOpen, openAddMenu, closeAddMenu] = useFlag();

  const handleModuleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openModule(e.currentTarget.dataset.module as ParvaneModuleId, isSettingsOpen);
  });

  // «+» зависит от модуля, как на телефоне: меню в «Чатах», «Файлах» и «Профиле», быстрый ввод записи
  // в «Плане» и «Здоровье», новая заметка в «Заметках»
  const hasAddMenu = activeModule === 'chats' || activeModule === 'files' || activeModule === 'profile'
    || activeModule === 'music';
  const handleAddClick = useLastCallback(() => {
    if (hasAddMenu) openAddMenu();
    else if (activeModule === 'notes') requestModuleAdd('note');
    else if (activeModule === 'health') requestHealthAdd();
    else requestPlannerAdd();
  });

  const handleNewMessage = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
  });

  const handleNewGroup = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.NewGroupStep1 });
  });

  const handleNewChannel = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.NewChannelStep1 });
  });

  const handleUpload = useLastCallback(() => requestModuleAdd('upload'));
  const handleNewFolder = useLastCallback(() => requestModuleAdd('folder'));

  if (!isActive) {
    return undefined;
  }

  return (
    <div className={styles.root} id="FoldersSidebar">
      <div
        className={styles.sections}
        role="tablist"
        aria-label={lang('ParvaneModules')}
        data-modules={modules.join(' ')}
      >
        {modules.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-module={id}
            aria-selected={id === activeModule}
            className={buildClassName(styles.section, id === activeModule && styles.sectionActive)}
            onClick={handleModuleClick}
          >
            <ParvaneIcon name={MODULE_ICONS[id]} />
            <span className={styles.sectionTitle}>{lang(MODULE_TITLE_KEYS[id])}</span>
            {id === 'chats' && Boolean(unreadCount) && (
              <span className={styles.badge}>
                {unreadCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className={styles.spacer} />
      <MusicMiniPlayer isCompact />
      {/* Общий поиск (палитра): заметки, записи «Плана», чаты и команды. То же — Ctrl+K */}
      <button
        type="button"
        className={styles.section}
        title={`${lang('Search')} (${IS_MAC_OS ? '⌘K' : 'Ctrl+K'})`}
        aria-label={lang('Search')}
        onClick={openPalette}
      >
        <ParvaneIcon name="search" />
      </button>
      <div className={styles.addWrap}>
        <button
          type="button"
          className={styles.addButton}
          aria-label={lang('ParvaneTabBarAdd')}
          aria-haspopup={hasAddMenu ? 'menu' : undefined}
          data-add-for={activeModule}
          onClick={handleAddClick}
        >
          <ParvaneIcon name="plus" className={styles.addIcon} />
        </button>
        <Menu
          isOpen={isAddMenuOpen}
          className={styles.addMenu}
          positionX="left"
          positionY="bottom"
          autoClose
          onClose={closeAddMenu}
        >
          {activeModule === 'files' ? (
            <>
              <MenuItem icon="download" onClick={handleUpload}>{lang('ParvaneAddUpload')}</MenuItem>
              <MenuItem icon="folder" onClick={handleNewFolder}>{lang('ParvaneAddFolder')}</MenuItem>
            </>
          ) : (
            <>
              <MenuItem icon="user" onClick={handleNewMessage}>{lang('NewMessageTitle')}</MenuItem>
              <MenuItem icon="group" onClick={handleNewGroup}>{lang('NewGroup')}</MenuItem>
              <MenuItem icon="channel" onClick={handleNewChannel}>{lang('NewChannel')}</MenuItem>
              <MenuItem icon="calendar" onClick={requestPlannerAdd}>{lang('ParvaneTabBarPlanEntry')}</MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): StateProps => {
    return {
      isSettingsOpen: selectLeftColumnContentKey(global) === LeftColumnContent.Settings,
    };
  },
)(FoldersSidebar));
