import { useEffect, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  id?: string;
  label: string;
  type: 'date' | 'time' | 'number' | 'text';
  value?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number | 'any';
  maxLength?: number;
  disabled?: boolean;
  className?: string;
  // Значение отдаётся по завершении ввода (потеря фокуса, Enter; дата и время — сразу)
  onCommit?: (value: string) => void;
  // Значение на каждое изменение — для форм, которые читают поля при отправке
  onInput?: (value: string) => void;
};

// Parvane (spec 009): поле даты, времени и числа в виде полей мессенджера
// (`InputText` умеет только текст)
const PlannerField = ({
  id, label, type, value, placeholder, min, max, step, maxLength, disabled, className, onCommit, onInput,
}: OwnProps) => {
  const [draft, setDraft] = useState(value || '');

  useEffect(() => {
    setDraft(value || '');
  }, [value]);

  const commit = useLastCallback((next: string) => {
    if (next !== (value || '')) onCommit?.(next);
  });

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value;
    setDraft(next);
    onInput?.(next);
    if (type === 'date' || type === 'time') commit(next);
  });

  const handleBlur = useLastCallback(() => {
    commit(draft);
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onCommit) {
      e.preventDefault();
      commit(draft);
    }
  });

  return (
    <label className={buildClassName(styles.field, className)}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        id={id}
        className={buildClassName('form-control', styles.fieldInput)}
        type={type}
        value={draft}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        disabled={disabled}
        aria-label={label}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    </label>
  );
};

export default PlannerField;
