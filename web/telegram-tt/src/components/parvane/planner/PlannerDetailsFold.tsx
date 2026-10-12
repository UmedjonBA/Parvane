import type { TeactNode } from '../../../lib/teact/teact';
import { useState } from '../../../lib/teact/teact';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';

import styles from './Planner.module.scss';

type OwnProps = {
  // Сводка содержимого — видна, пока блок свёрнут
  summary: string;
  children: TeactNode;
};

const FOLD_KEY = 'parvane:planner-details';

// Раскрыт ли блок — привычка устройства; хранилище может быть недоступно
function readIsOpen() {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch (err) {
    return false;
  }
}

// Карточка записи (spec 018): сворачиваемый блок «Повтор и детали»
const PlannerDetailsFold = ({ summary, children }: OwnProps) => {
  const [isOpen, setIsOpen] = useState(readIsOpen);

  const lang = useLang();

  const handleToggle = useLastCallback(() => {
    const next = !isOpen;
    setIsOpen(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? '1' : '0');
    } catch (err) {
      // Выбор просто не запомнится
    }
  });

  return (
    <div className={styles.detailsFold} data-planner-details={isOpen ? 'open' : 'closed'}>
      <button type="button" className={styles.detailsToggle} aria-expanded={isOpen} onClick={handleToggle}>
        <span className={styles.detailsText}>
          <span className={styles.detailsLabel}>{lang('PlannerDetails')}</span>
          {Boolean(summary) && <span className={styles.detailsSummary}>{summary}</span>}
        </span>
        <Icon name={isOpen ? 'up' : 'down'} />
      </button>
      {isOpen && <div className={styles.detailsBody}>{children}</div>}
    </div>
  );
};

export default PlannerDetailsFold;
