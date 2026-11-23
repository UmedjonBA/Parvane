import { memo } from '@teact';
import { getActions, withGlobal } from '../../global';

import type { ParvaneModuleId } from '../../util/parvaneModules';
import { LeftColumnContent } from '../../types';

import { ALL_FOLDER_ID } from '../../config';
import { selectLeftColumnContentKey } from '../../global/selectors';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import { openHealthQuick } from '../../util/parvaneQuick';
import {
  getParvaneSection, requestModuleAdd, requestPlannerAdd, setParvaneSection,
} from '../../util/parvaneSection';
import { openMusicView } from '../parvane/music/musicView';
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

import MusicAddMenuItems from '../parvane/music/MusicAddMenuItems';
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
  // Узкое окно компьютера (доска `RdNarrow`): панель 56 px только значками, плеер 40 px, «+» 44 × 40
  isNarrow?: boolean;
  // Прежнее положение папок «слева»: папки теперь всегда полосой над списком чатов, значение не читается
  withFolders?: boolean;
};

const MAX_BADGE_COUNT = 99;

// Parvane: боковая панель модулей на компьютере. Сверху знак и модули в порядке пользователя
// (`parvaneModules`), внизу общий поиск (палитра Ctrl+K) и «+». «Профиль» — такой же модуль, как остальные.
// Папок чатов здесь нет — они над списком чатов.
// На телефоне модули в нижней ленте (`ParvaneTabBar`)
const FoldersSidebar = ({ isActive, isNarrow, isSettingsOpen }: OwnProps & StateProps) => {
  const { openChat, openLeftColumnContent } = getActions();

  const lang = useLang();

  const section = useDerivedState(getParvaneSection);
  const { enabled: modules } = useParvaneModules();
  const unreadCount = useFolderManagerForUnreadCounters()[ALL_FOLDER_ID]?.chatsCount || 0;

  const activeModule = getActiveModule(section, isSettingsOpen);
  const [isAddMenuOpen, openAddMenu, closeAddMenu] = useFlag();

  const handleModuleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.module as ParvaneModuleId;
    // Узкое окно — одна колонка (доска `RdNarrow`): «Чаты» в «Чатах» возвращают из открытого чата к списку
    if (isNarrow && id === 'chats' && activeModule === 'chats') openChat({ id: undefined });
    // «Музыка» в «Музыке» — на главную модуля (пункта «Главная» в медиатеке нет, доска `DeskMusic`)
    if (id === 'music' && activeModule === 'music') openMusicView({ kind: 'home' }, true);
    openModule(id, isSettingsOpen);
  });

  // «+» зависит от модуля, как на телефоне: меню в «Чатах», «Файлах» и «Музыке», быстрый ввод записи
  // в «Плане», шторка «Запись в здоровье» в «Здоровье», новая заметка в «Заметках»; в «Профиле» кнопки нет.
  // Открытое меню закрывает сама кнопка (на ней тогда «×»)
  const hasAddMenu = activeModule === 'chats' || activeModule === 'files' || activeModule === 'music';
  const handleAddClick = useLastCallback(() => {
    if (isAddMenuOpen) closeAddMenu();
    else if (hasAddMenu) openAddMenu();
    else if (activeModule === 'notes') requestModuleAdd('note');
    else if (activeModule === 'health') openHealthQuick();
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

  const searchLabel = lang('ParvaneNavGlobalSearch', { keys: IS_MAC_OS ? '⌘K' : 'Ctrl+K' });

  return (
    <div className={buildClassName(styles.root, isNarrow && styles.rootNarrow)} id="FoldersSidebar">
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
            aria-label={isNarrow ? lang(MODULE_TITLE_KEYS[id]) : undefined}
            title={isNarrow ? lang(MODULE_TITLE_KEYS[id]) : undefined}
            className={buildClassName(styles.section, id === activeModule && styles.sectionActive)}
            onClick={handleModuleClick}
          >
            <ParvaneIcon name={MODULE_ICONS[id]} className={styles.sectionIcon} />
            {!isNarrow && <span className={styles.sectionTitle}>{lang(MODULE_TITLE_KEYS[id])}</span>}
            {id === 'chats' && Boolean(unreadCount) && (
              <span className={styles.badge}>
                {unreadCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className={styles.spacer} />
      {/* В самой «Музыке» плеер — внизу модуля во всю ширину (доска `DeskMusic`), виджет ленты не нужен */}
      {section !== 'music' && (
        <div className={buildClassName(isNarrow && styles.playerNarrow)}>
          <MusicMiniPlayer isCompact />
        </div>
      )}
      {/* Общий поиск (палитра): заметки, записи «Плана», чаты, файлы, треки и команды. То же — Ctrl+K. В узком
          окне кнопки нет: поиск — в шапке колонки (доска `RdNarrow`) */}
      {!isNarrow && (
        <button
          type="button"
          className={styles.searchButton}
          title={searchLabel}
          aria-label={searchLabel}
          onClick={openPalette}
        >
          <ParvaneIcon name="search" />
        </button>
      )}
      {activeModule !== 'profile' && (
        <div className={styles.addWrap}>
          <button
            type="button"
            className={buildClassName(styles.addButton, isAddMenuOpen && styles.addButtonOpen)}
            aria-label={lang(
              isAddMenuOpen ? 'ParvaneNavCloseMenu'
                : activeModule === 'music' ? 'MusicAddLabel'
                  : activeModule === 'files' ? 'ParvaneCloudAddLabel'
                    : activeModule === 'health' ? 'HealthAddMetric' : 'ParvaneTabBarAdd',
            )}
            aria-haspopup={hasAddMenu ? 'menu' : undefined}
            aria-expanded={hasAddMenu ? isAddMenuOpen : undefined}
            data-add-for={activeModule}
            onClick={handleAddClick}
          >
            <ParvaneIcon name={isAddMenuOpen ? 'close' : 'plus'} className={styles.addIcon} />
          </button>
          <Menu
            isOpen={isAddMenuOpen}
            className={styles.addMenu}
            bubbleClassName={styles.addMenuBubble}
            backdropExcludedSelector="[data-add-for]"
            positionX="left"
            positionY="bottom"
            autoClose
            onClose={closeAddMenu}
          >
            {activeModule === 'music' ? (
              <>
                <MusicAddMenuItems />
              </>
            ) : activeModule === 'files' ? (
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
      )}
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
