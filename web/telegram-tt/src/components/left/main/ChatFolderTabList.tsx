import { memo, useRef } from '../../../lib/teact/teact';

import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { TabWithProperties } from '../../ui/TabList';

import { MouseButton } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { emojiToFolderIcon, getFolderIconImage } from '../../../util/folderIconMap';
import renderText from '../../common/helpers/renderText';

import useContextMenuHandlers from '../../../hooks/useContextMenuHandlers';
import { useFastClick } from '../../../hooks/useFastClick';
import useHorizontalScroll from '../../../hooks/useHorizontalScroll';
import useLastCallback from '../../../hooks/useLastCallback';
import useScrollToActiveTab from '../../../hooks/useScrollToActiveTab';

import CustomEmoji from '../../common/CustomEmoji';
import Icon from '../../common/icons/Icon';
import ParvaneIcon from '../../main/ParvaneIcon';
import Menu from '../../ui/Menu';
import MenuItem from '../../ui/MenuItem';
import MenuSeparator from '../../ui/MenuSeparator';

import styles from './ChatFolderTabList.module.scss';

type OwnProps = {
  tabs: readonly TabWithProperties[];
  activeTab: number;
  // Цвет каждой папки — значение CSS (`var(--pv-blue)`), в том же порядке, что `tabs`
  colors?: readonly string[];
  className?: string;
  onSwitchTab: (index: number) => void;
};

type ChipProps = {
  tab: TabWithProperties;
  index: number;
  isActive: boolean;
  color?: string;
  onClick: (index: number) => void;
};

const EMOJI_SIZE = 18;
const CONTEXT_MENU_CLASS = 'ChatFolderChip-context-menu';

// Значок папки хранится эмодзи (`emoticon`). Одноцветные значки: линейные оболочки, затем шрифт папок
// Telegram; у остальных эмодзи остаётся сам символ, обесцвеченный
const LINE_ICONS: Record<string, ParvaneIconName> = {
  '💬': 'chats',
  '🎓': 'cap',
  '💼': 'work',
  '🏠': 'home',
  '👤': 'user',
  '👥': 'users',
  '📢': 'megaphone',
  '❤️': 'heart',
  '📕': 'book',
  '⭐': 'star',
  '📁': 'folder',
  '🗂': 'folder',
  '🔔': 'bell',
  '📋': 'note',
};

function renderChipIcon(tab: TabWithProperties) {
  const { emoticon } = tab;
  if (typeof emoticon === 'object') {
    return <CustomEmoji documentId={emoticon.documentId} size={EMOJI_SIZE} shouldNotLoop />;
  }

  if (!emoticon) return <ParvaneIcon name="folder" isSmall />;

  const image = getFolderIconImage(emoticon);
  if (image) return <i className={styles.maskIcon} style={`--folder-icon: url("${image}")`} aria-hidden />;

  const lineIcon = LINE_ICONS[emoticon];
  if (lineIcon) return <ParvaneIcon name={lineIcon} isSmall />;

  const fontIcon = emojiToFolderIcon(emoticon);
  if (fontIcon) return <Icon name={fontIcon} className={styles.fontIcon} />;

  return <span className={styles.emoji}>{renderText(emoticon)}</span>;
}

const FolderChip = ({
  tab, index, isActive, color, onClick,
}: ChipProps) => {
  const ref = useRef<HTMLDivElement>();
  const { contextActions } = tab;

  const {
    contextMenuAnchor, handleContextMenu, handleBeforeContextMenu, handleContextMenuClose,
    handleContextMenuHide, isContextMenuOpen,
  } = useContextMenuHandlers(ref, !contextActions);

  const { handleClick, handleMouseDown } = useFastClick((e: React.MouseEvent<HTMLDivElement>) => {
    if (contextActions && e.button === MouseButton.Secondary) {
      handleBeforeContextMenu(e);
    }

    if (e.type === 'mousedown' && e.button !== MouseButton.Main) {
      return;
    }

    onClick(index);
  });

  const getTriggerElement = useLastCallback(() => ref.current);
  const getRootElement = useLastCallback(() => document.body);
  const getMenuElement = useLastCallback(
    () => document.querySelector('#portals')!.querySelector(`.${CONTEXT_MENU_CLASS} .bubble`),
  );
  const getLayout = useLastCallback(() => ({ withPortal: true }));

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={isActive}
      className={buildClassName(styles.chip, isActive && styles.chipActive)}
      style={color ? `--chip-color: ${color}` : undefined}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
    >
      <span className={styles.chipIcon}>{renderChipIcon(tab)}</span>
      <span className={styles.title}>{typeof tab.title === 'string' ? renderText(tab.title) : tab.title}</span>
      {Boolean(tab.badgeCount) && (
        <span className={buildClassName(styles.badge, !tab.isBadgeActive && styles.badgeMuted)}>
          {tab.badgeCount}
        </span>
      )}
      {tab.isBlocked && <Icon name="lock-badge" className={styles.lockIcon} />}
      {contextActions && contextMenuAnchor !== undefined && (
        <Menu
          isOpen={isContextMenuOpen}
          anchor={contextMenuAnchor}
          getTriggerElement={getTriggerElement}
          getRootElement={getRootElement}
          getMenuElement={getMenuElement}
          getLayout={getLayout}
          className={CONTEXT_MENU_CLASS}
          autoClose
          onClose={handleContextMenuClose}
          onCloseAnimationEnd={handleContextMenuHide}
          withPortal
        >
          {contextActions.map((action) => (
            ('isSeparator' in action) ? (
              <MenuSeparator key={action.key || 'separator'} />
            ) : (
              <MenuItem
                key={action.title}
                icon={action.icon}
                destructive={action.destructive}
                disabled={!action.handler}
                onClick={action.handler}
              >
                {action.title}
              </MenuItem>
            )
          ))}
        </Menu>
      )}
    </div>
  );
};

// Parvane: папки чатов — полоса чипов над списком (и на компьютере): значок одним цветом, цвет папки,
// счётчик непрочитанных в цвет папки. Выбранная папка залита её цветом
const ChatFolderTabList = ({
  tabs,
  activeTab,
  colors,
  className,
  onSwitchTab,
}: OwnProps) => {
  const containerRef = useRef<HTMLDivElement>();

  useHorizontalScroll(containerRef, !tabs.length, true);
  useScrollToActiveTab(containerRef, activeTab);

  return (
    <div ref={containerRef} role="tablist" className={buildClassName(styles.root, 'no-scrollbar', className)}>
      {tabs.map((tab, i) => (
        <FolderChip
          key={tab.id ?? i}
          tab={tab}
          index={i}
          isActive={i === activeTab}
          color={colors?.[i]}
          onClick={onSwitchTab}
        />
      ))}
    </div>
  );
};

export default memo(ChatFolderTabList);
