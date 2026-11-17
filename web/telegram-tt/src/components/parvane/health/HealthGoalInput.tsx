import { memo, useEffect, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { parseNumber } from './healthFormat';
import { setHealthGoal } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  // Имя цели в домене: `kcal`, `protein`, `active_min` …
  id: string;
  label: string;
  value?: number;
  unit?: string;
};

// Parvane (spec 041 B3): цель одним полем — правится на месте, сохраняется по выходу из поля; пустое поле
// снимает цель, не число возвращает прежнее значение
const HealthGoalInput = ({
  id, label, value, unit,
}: OwnProps) => {
  const lang = useLang();
  const [text, setText] = useState('');

  useEffect(() => {
    setText(value === undefined ? '' : String(value));
  }, [value, id]);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
  });

  // Значение берётся из самого поля: выход из поля может прийти раньше перерисовки после ввода
  const handleCommit = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const typed = e.currentTarget.value.trim();
    const target = typed ? parseNumber(typed) : undefined;
    if (typed && (target === undefined || target <= 0)) {
      setText(value === undefined ? '' : String(value));
      return;
    }
    if (target !== value) void setHealthGoal(id, target);
  });

  return (
    <label className={styles.goal}>
      <span className={buildClassName(kit.muted, kit.grow)}>{label}</span>
      <input
        className={buildClassName(kit.input, styles.goalInput)}
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={lang('HealthGoalNone')}
        data-health-goal={id}
        onChange={handleChange}
        onBlur={handleCommit}
      />
      {Boolean(unit) && <span className={kit.muted}>{unit}</span>}
    </label>
  );
};

export default memo(HealthGoalInput);
