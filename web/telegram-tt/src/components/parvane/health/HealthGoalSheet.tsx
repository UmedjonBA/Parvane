import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatClock, parseClock, parseNumber } from './healthFormat';
import { setHealthGoal } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

// Что правится: цель показателя (`kind`, число) либо режим сна (`sleep`: «лечь» и «встать»)
export type HealthGoalTarget = {
  kind: string;
  title: string;
  unit?: string;
  value?: number;
  bedMin?: number;
  wakeMin?: number;
  hint?: string;
};

type OwnProps = {
  target?: HealthGoalTarget;
  onClose: NoneToVoidFunction;
};

// Parvane (spec 041; доски `HealthSleep`, `HealthWeight`, `RpHealth`, `DeskHealthDetail`, `RdHealth`): правка цели
// по карандашу либо «Изменить цель» — окном. Пустое поле снимает цель
const HealthGoalSheet = ({ target, onClose }: OwnProps) => {
  const lang = useLang();
  const [text, setText] = useState('');
  const [bed, setBed] = useState('');
  const [wake, setWake] = useState('');
  const [isBad, setIsBad] = useState(false);
  const isSleep = target?.kind === 'sleep';

  useLayoutEffect(() => {
    if (!target) return;
    setIsBad(false);
    setText(target.value === undefined ? '' : String(target.value));
    setBed(target.bedMin === undefined ? '' : formatClock(target.bedMin));
    setWake(target.wakeMin === undefined ? '' : formatClock(target.wakeMin));
  }, [target]);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.currentTarget;
    if (name === 'bed') setBed(value);
    else if (name === 'wake') setWake(value);
    else setText(value);
    setIsBad(false);
  });

  const handleSave = useLastCallback(async () => {
    if (!target) return;
    if (isSleep) {
      const bedMin = bed ? parseClock(bed) : undefined;
      const wakeMin = wake ? parseClock(wake) : undefined;
      if (bedMin !== target.bedMin) await setHealthGoal('sleep_bed', bedMin);
      if (wakeMin !== target.wakeMin) await setHealthGoal('sleep_wake', wakeMin);
      onClose();
      return;
    }
    const typed = text.trim();
    const value = typed ? parseNumber(typed) : undefined;
    if (typed && (value === undefined || value <= 0)) {
      setIsBad(true);
      return;
    }
    if (value !== target.value) await setHealthGoal(target.kind, value);
    onClose();
  });

  function renderTime(name: 'bed' | 'wake', value: string) {
    return (
      <label className={styles.field}>
        <span className={buildClassName(kit.muted, kit.small)}>
          {lang(name === 'bed' ? 'HealthSleepGoalBed' : 'HealthSleepGoalWake')}
        </span>
        <input
          className={kit.input}
          type="time"
          name={name}
          value={value}
          data-health-goal={name === 'bed' ? 'sleep_bed' : 'sleep_wake'}
          onChange={handleChange}
        />
      </label>
    );
  }

  return (
    <PvSheet isOpen={Boolean(target)} title={target?.title} onClose={onClose} onEnter={handleSave}>
      <div className={styles.fields} data-health-sheet="goal">
        {isSleep ? (
          <div className={styles.fieldRow}>
            {renderTime('bed', bed)}
            {renderTime('wake', wake)}
          </div>
        ) : (
          <label className={styles.goal}>
            <input
              className={buildClassName(kit.input, kit.grow)}
              type="text"
              inputMode="decimal"
              name="value"
              value={text}
              placeholder={lang('HealthGoalNone')}
              data-health-goal={target?.kind}
              onChange={handleChange}
            />
            {Boolean(target?.unit) && <span className={kit.muted}>{target.unit}</span>}
          </label>
        )}
        {Boolean(target?.hint) && <div className={buildClassName(kit.muted, kit.small)}>{target.hint}</div>}
        {isBad && <div className={kit.fieldError} role="alert">{lang('HealthFormProblemValue')}</div>}
      </div>
      <div className={buildClassName(kit.sheetButtons, styles.sheetColumn)}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
          data-health-goal-save
          onClick={handleSave}
        >
          {lang('Save')}
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(HealthGoalSheet);
