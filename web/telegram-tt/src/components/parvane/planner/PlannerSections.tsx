import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './PlannerMore.module.scss';

export type PlannerSection = 'today' | 'calendar' | 'deadlines' | 'undated' | 'groups' | 'import' | 'settings';

type OwnProps = {
  active: PlannerSection;
  undatedCount: number;
  onSelect: (section: PlannerSection) => void;
};

const ITEMS: PlannerSection[] = ['today', 'calendar', 'deadlines', 'undated', 'groups', 'import'];

// Колонка разделов «Плана» на компьютере (доска `DkPlanMore`): видна на экранах «Задачи» и «Расписание на неделю»,
// «Сегодня» и «Календарь» возвращают к видам, внизу — «Настройки плана»
const PlannerSections = ({ active, undatedCount, onSelect }: OwnProps) => {
  const lang = useLang();

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onSelect(e.currentTarget.dataset.section as PlannerSection);
  });

  function getLabel(section: PlannerSection) {
    switch (section) {
      case 'today': return lang('PlannerToday');
      case 'calendar': return lang('PlannerViewCalendar');
      case 'deadlines': return lang('PlannerSectionDeadlines');
      case 'undated': return lang('PlannerSectionUndated');
      case 'groups': return lang('PlannerGroups');
      case 'import': return lang('PlannerScheduleTitle');
      default: return lang('PlannerSettings');
    }
  }

  function renderItem(section: PlannerSection) {
    return (
      <button
        key={section}
        type="button"
        className={buildClassName(styles.navItem, section === active && styles.navItemOn)}
        aria-current={section === active ? 'page' : undefined}
        data-section={section}
        onClick={handleClick}
      >
        <span className={styles.navLabel}>{getLabel(section)}</span>
        {section === 'undated' && Boolean(undatedCount) && <span className={styles.navCount}>{undatedCount}</span>}
      </button>
    );
  }

  return (
    <nav className={styles.sections} aria-label={lang('PlannerSectionsLabel')} data-planner-sections>
      {ITEMS.map(renderItem)}
      <span className={styles.navGap} />
      {renderItem('settings')}
    </nav>
  );
};

export default memo(PlannerSections);
