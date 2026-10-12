import { memo } from '@teact';
import { getActions, withGlobal } from '../../global';

import type { ParvaneIconName } from './ParvaneIcon';
import { LeftColumnContent, SettingsScreens } from '../../types';

import { ALL_FOLDER_ID } from '../../config';
import { selectLeftColumnContentKey } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import {
  getKnowledgeView, getParvaneSection, getPlannerView, openKnowledgeView, openPlannerView, setParvaneSection,
} from '../../util/parvaneSection';

import useDerivedState from '../../hooks/useDerivedState';
import { useFolderManagerForUnreadCounters } from '../../hooks/useFolderManager';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

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

// Parvane: боковая панель разделов на компьютере. Сверху знак и разделы (Чаты, Сегодня, Календарь,
// Здоровье, Знания, Облако), внизу поиск и профиль. Папок чатов здесь нет — они над списком чатов.
// На телефоне разделы в нижней панели (`ParvaneTabBar`)
const FoldersSidebar = ({ isActive, isSettingsOpen }: OwnProps & StateProps) => {
  const { openLeftColumnContent, openSettingsScreen } = getActions();

  const lang = useLang();

  const section = useDerivedState(getParvaneSection);
  const plannerView = useDerivedState(getPlannerView);
  const knowledgeView = useDerivedState(getKnowledgeView);
  const unreadCount = useFolderManagerForUnreadCounters()[ALL_FOLDER_ID]?.chatsCount || 0;

  const isProfileOpen = section === 'messenger' && isSettingsOpen;
  const isFilesOpen = section === 'cloud' && knowledgeView === 'files';

  // Из «Профиля» «Чаты» возвращают к списку чатов; в остальном колонка остаётся, как была
  const handleSelectChats = useLastCallback(() => {
    setParvaneSection('messenger');
    if (isSettingsOpen) openLeftColumnContent({ contentKey: LeftColumnContent.ChatList });
  });

  const handleSelectToday = useLastCallback(() => {
    openPlannerView('today');
  });

  const handleSelectCalendar = useLastCallback(() => {
    openPlannerView('calendar');
  });

  const handleSelectHealth = useLastCallback(() => {
    openPlannerView('health');
  });

  const handleSelectKnowledge = useLastCallback(() => {
    openKnowledgeView('notes');
  });

  const handleSelectFiles = useLastCallback(() => {
    openKnowledgeView('files');
  });

  // Поиск по всему приложению (заметки, записи, команды) не сделан: кнопка открывает поиск по чатам
  const handleSearch = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.GlobalSearch });
  });

  const handleSelectProfile = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
    openSettingsScreen({ screen: SettingsScreens.Main });
  });

  if (!isActive) {
    return undefined;
  }

  function renderTab(
    icon: ParvaneIconName, title: string, isSelected: boolean, onClick: NoneToVoidFunction, badge?: number,
  ) {
    return (
      <button
        type="button"
        role="tab"
        aria-selected={isSelected}
        className={buildClassName(styles.section, isSelected && styles.sectionActive)}
        onClick={onClick}
      >
        <ParvaneIcon name={icon} />
        <span className={styles.sectionTitle}>{title}</span>
        {Boolean(badge) && (
          <span className={styles.badge}>{badge > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : badge}</span>
        )}
      </button>
    );
  }

  return (
    <div className={styles.root} id="FoldersSidebar">
      <div className={styles.logo} aria-hidden>parvane</div>
      <div className={styles.sections} role="tablist" aria-label={lang('ParvaneSections')}>
        {renderTab(
          'chat', lang('ParvaneSectionMessenger'), section === 'messenger' && !isSettingsOpen, handleSelectChats,
          unreadCount,
        )}
        {renderTab('sun', lang('PlannerToday'), section === 'planner' && plannerView === 'today', handleSelectToday)}
        {renderTab(
          'calendar', lang('PlannerViewCalendar'), section === 'planner' && plannerView === 'calendar',
          handleSelectCalendar,
        )}
        {renderTab(
          'heart', lang('PlannerHealth'), section === 'planner' && plannerView === 'health', handleSelectHealth,
        )}
        {renderTab(
          'book', lang('ParvaneSectionKnowledge'), section === 'cloud' && !isFilesOpen, handleSelectKnowledge,
        )}
        {renderTab('cloud', lang('ParvaneSectionCloud'), isFilesOpen, handleSelectFiles)}
      </div>
      <div className={styles.spacer} />
      <button type="button" className={styles.section} onClick={handleSearch}>
        <ParvaneIcon name="search" />
        <span className={styles.sectionTitle}>{lang('Search')}</span>
      </button>
      <button
        type="button"
        className={buildClassName(styles.section, isProfileOpen && styles.sectionActive)}
        aria-current={isProfileOpen ? 'page' : undefined}
        onClick={handleSelectProfile}
      >
        <ParvaneIcon name="user" />
        <span className={styles.sectionTitle}>{lang('ParvaneTabBarProfile')}</span>
      </button>
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
