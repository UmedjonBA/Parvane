import { memo, useEffect, useRef } from '@teact';
import { getActions } from '../../global';

import type { ParvaneModuleId } from '../../util/parvaneModules';
import type { ParvaneSection } from '../../util/parvaneSection';
import { LeftColumnContent } from '../../types';

import { ALL_FOLDER_ID } from '../../config';
import buildClassName from '../../util/buildClassName';
import {
  getKnowledgeView, getPlannerView, requestModuleAdd, requestPlannerAdd,
} from '../../util/parvaneSection';
import {
  getActiveModule, MODULE_ICONS, MODULE_TITLE_KEYS, openModule,
} from './parvaneModuleNav';

import useDerivedState from '../../hooks/useDerivedState';
import useFlag from '../../hooks/useFlag';
import { useFolderManagerForUnreadCounters } from '../../hooks/useFolderManager';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useParvaneModules from '../../hooks/useParvaneModules';

import Menu from '../ui/Menu';
import MenuItem from '../ui/MenuItem';
import ParvaneIcon from './ParvaneIcon';

import styles from './ParvaneTabBar.module.scss';

type OwnProps = {
  section: ParvaneSection;
  isSettingsOpen?: boolean;
};

const MAX_BADGE_COUNT = 99;
// До пяти модулей лента не прокручивается: значки делят ширину поровну
const MAX_FIT_MODULES = 5;
// Ширина значка в прокручиваемой ленте (`.item`), px — шаг стрелок
const ITEM_WIDTH = 60;
const SCROLL_STEP_ITEMS = 3;

// Parvane: нижняя лента модулей на телефоне и плавающая кнопка «+» над ней. Состав и порядок — из списка
// модулей устройства (`parvaneModules`). По краям ленты поля со стрелками: свайп от края экрана целиком
// достаётся системному жесту «назад», лента листается нажатием. На компьютере модули в боковой панели
// (`FoldersSidebar`)
const ParvaneTabBar = ({ section, isSettingsOpen }: OwnProps) => {
  const { openLeftColumnContent } = getActions();

  const lang = useLang();
  const scrollRef = useRef<HTMLDivElement>();
  const { enabled: modules } = useParvaneModules();
  const plannerView = useDerivedState(getPlannerView);
  const knowledgeView = useDerivedState(getKnowledgeView);
  const unreadCount = useFolderManagerForUnreadCounters()[ALL_FOLDER_ID]?.chatsCount || 0;

  const activeModule = getActiveModule(section, plannerView, knowledgeView, Boolean(isSettingsOpen));
  const isScrollable = modules.length > MAX_FIT_MODULES;

  const [isAddMenuOpen, openAddMenu, closeAddMenu] = useFlag();
  const [canScrollBack, markCanScrollBack, unmarkCanScrollBack] = useFlag();
  const [canScrollForward, markCanScrollForward, unmarkCanScrollForward] = useFlag();

  const updateArrows = useLastCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (scroller.scrollLeft > 1) markCanScrollBack();
    else unmarkCanScrollBack();
    if (scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1) markCanScrollForward();
    else unmarkCanScrollForward();
  });

  // Открытый модуль всегда виден на ленте
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !isScrollable) return;
    const index = modules.indexOf(activeModule);
    const start = index * ITEM_WIDTH;
    if (start < scroller.scrollLeft) scroller.scrollLeft = start;
    else if (start + ITEM_WIDTH > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = start + ITEM_WIDTH - scroller.clientWidth;
    }
    updateArrows();
  }, [activeModule, isScrollable, modules]);

  const handleScrollBack = useLastCallback(() => {
    scrollRef.current?.scrollBy({ left: -ITEM_WIDTH * SCROLL_STEP_ITEMS });
  });

  const handleScrollForward = useLastCallback(() => {
    scrollRef.current?.scrollBy({ left: ITEM_WIDTH * SCROLL_STEP_ITEMS });
  });

  const handleModuleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openModule(e.currentTarget.dataset.module as ParvaneModuleId, Boolean(isSettingsOpen));
  });

  // «+» зависит от модуля: в «Чатах» и «Файлах» — меню, в «Плане» и «Здоровье» — быстрый ввод записи,
  // в «Заметках» — новая заметка; в «Профиле» кнопки нет
  const hasAddMenu = activeModule === 'chats' || activeModule === 'files';
  const handleAddClick = useLastCallback(() => {
    if (hasAddMenu) openAddMenu();
    else if (activeModule === 'notes') requestModuleAdd('note');
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

  const handleUpload = useLastCallback(() => requestModuleAdd('upload'));
  const handleNewFolder = useLastCallback(() => requestModuleAdd('folder'));

  return (
    <>
      <nav className={styles.root} aria-label={lang('ParvaneModules')} data-modules={modules.join(' ')}>
        {isScrollable && (
          <button
            type="button"
            className={buildClassName(styles.gutter, !canScrollBack && styles.gutterOff)}
            aria-label={lang('ParvaneRibbonBack')}
            disabled={!canScrollBack}
            onClick={handleScrollBack}
          >
            <ParvaneIcon name="left" className={styles.gutterIcon} />
          </button>
        )}
        <div
          ref={scrollRef}
          className={buildClassName(styles.items, !isScrollable && styles.itemsFit)}
          onScroll={isScrollable ? updateArrows : undefined}
        >
          {modules.map((id) => (
            <button
              key={id}
              type="button"
              data-module={id}
              className={buildClassName(styles.item, id === activeModule && styles.itemActive)}
              aria-current={id === activeModule ? 'page' : undefined}
              onClick={handleModuleClick}
            >
              <ParvaneIcon name={MODULE_ICONS[id]} />
              <span className={styles.title}>{lang(MODULE_TITLE_KEYS[id])}</span>
              {id === 'chats' && Boolean(unreadCount) && (
                <span className={styles.badge}>
                  {unreadCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>
        {isScrollable && (
          <button
            type="button"
            className={buildClassName(styles.gutter, !canScrollForward && styles.gutterOff)}
            aria-label={lang('ParvaneRibbonForward')}
            disabled={!canScrollForward}
            onClick={handleScrollForward}
          >
            <ParvaneIcon name="right" className={styles.gutterIcon} />
          </button>
        )}
      </nav>
      {activeModule !== 'profile' && (
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
            positionX="right"
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
      )}
    </>
  );
};

export default memo(ParvaneTabBar);
