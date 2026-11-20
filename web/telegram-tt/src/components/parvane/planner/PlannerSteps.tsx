import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerStep } from './plannerModel';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import { PlannerCardRow } from './PlannerCardRow';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type OwnProps = {
  steps: PlannerStep[];
  onToggle: (index: number, isDone: boolean) => void;
  onAdd: (text: string) => void;
};

const STEP_MAX_LENGTH = 160;

// Шаги записи — у задачи и у события (доска `PhPlanMore`): подпись «Шаги · N», строки с галочкой, строка ввода
// нового шага. Ввод — без своей формы: карточка события сама форма, а вложенная форма в разметке не живёт
const PlannerSteps = ({ steps, onToggle, onAdd }: OwnProps) => {
  const lang = useLang();
  const [text, setText] = useState('');

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onToggle(Number(e.currentTarget.value), e.currentTarget.checked);
  });

  const submit = useLastCallback((input?: HTMLInputElement) => {
    // Текст — из поля: Enter сразу после набора приходит раньше перерисовки, и состояние ещё пустое
    const value = (input?.value ?? text).trim();
    if (!value) return;
    if (input) input.value = '';
    setText('');
    onAdd(value);
  });

  // Enter в поле шага не отправляет карточку события, а добавляет шаг
  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const input = e.target as HTMLInputElement;
    if (e.key !== 'Enter' || input.tagName !== 'INPUT') return;
    e.preventDefault();
    submit(input);
  });

  const handleAddClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    submit(e.currentTarget.parentElement?.querySelector('input') || undefined);
  });

  const doneCount = steps.filter((step) => step.isDone).length;

  return (
    <PlannerCardRow icon="check" row="steps">
      <span className={buildClassName(styles.fieldLabel, styles.stepsCaption)}>
        {lang('PlannerSteps', { done: doneCount, total: steps.length })}
      </span>
      {steps.map((step, index) => (
        <label
          key={`${index}${step.text}`}
          className={buildClassName(styles.row, styles.rowButton, styles.rowStep, step.isDone && styles.rowDone)}
        >
          <input
            type="checkbox"
            className={buildClassName(styles.check, styles.checkSmall)}
            value={String(index)}
            checked={step.isDone}
            onChange={handleToggle}
          />
          <span className={styles.rowTitle}>{step.text}</span>
        </label>
      ))}
      <div className={styles.stepForm} onKeyDown={handleKeyDown}>
        <PlannerField
          label={lang('PlannerStepNew')}
          type="text"
          value={text}
          maxLength={STEP_MAX_LENGTH}
          placeholder={lang('PlannerStepAdd')}
          onInput={setText}
        />
        <button type="button" className={styles.ib} aria-label={lang('PlannerStepAdd')} onClick={handleAddClick}>
          <Icon name="add" />
        </button>
      </div>
    </PlannerCardRow>
  );
};

export default memo(PlannerSteps);
