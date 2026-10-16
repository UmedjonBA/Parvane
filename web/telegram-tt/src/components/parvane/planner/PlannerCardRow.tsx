import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useState } from '../../../lib/teact/teact';

import type { IconName } from '../../../types/icons';
import type { PlannerRepeatDraft } from './PlannerRepeatFields';

import { formatRepeat } from './plannerFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PlannerRepeatFields, { draftToRepeat } from './PlannerRepeatFields';

import styles from './Planner.module.scss';

type RowProps = {
  icon: IconName;
  // Метка строки для сценариев: `data-card-row`
  row: string;
  children: TeactNode;
};

// Строка карточки записи (событие, задача, новая запись): иконка слева, поля справа
export const PlannerCardRow = ({ icon, row, children }: RowProps) => (
  <div className={styles.cardRow} data-card-row={row}>
    <Icon name={icon} className={styles.cardRowIcon} />
    <div className={styles.cardRowBody}>{children}</div>
  </div>
);

type RepeatProps = {
  value: PlannerRepeatDraft;
  onChange: (update: (previous: PlannerRepeatDraft) => PlannerRepeatDraft) => void;
  // Под полями повтора (кнопка «Сохранить повтор», ошибка, ссылка на ряд)
  children?: TeactNode;
};

// Строка повтора: правило одной строкой, настройки раскрываются по нажатию
const PlannerRepeatRowInner = ({ value, onChange, children }: RepeatProps) => {
  const lang = useLang();
  const [isOpen, setIsOpen] = useState(false);

  const handleToggle = useLastCallback(() => {
    setIsOpen((current) => !current);
  });

  const repeat = draftToRepeat(value);

  return (
    <PlannerCardRow icon="loop" row="repeat">
      <button
        type="button"
        className={styles.cardRowButton}
        aria-expanded={isOpen}
        data-repeat-toggle
        onClick={handleToggle}
      >
        <span className={styles.cardRowButtonText}>
          {repeat ? formatRepeat(lang, repeat) : lang('PlannerRepeatKindNone')}
        </span>
        <Icon name={isOpen ? 'up' : 'down'} />
      </button>
      {isOpen && <PlannerRepeatFields value={value} onChange={onChange} />}
      {isOpen && children}
    </PlannerCardRow>
  );
};

export const PlannerRepeatRow = memo(PlannerRepeatRowInner);
