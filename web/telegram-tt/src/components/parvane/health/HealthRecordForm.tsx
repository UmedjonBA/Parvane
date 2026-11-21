import {
  memo, useLayoutEffect, useState,
} from '../../../lib/teact/teact';

import type { HealthDraft, HealthMetricView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatNumber, formatValue, parseNumber } from './healthFormat';
import { addHealthEntries, checkHealthEntry } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  kind: string;
  metric?: HealthMetricView;
};

const WEIGHT_STEP = 0.1;
const UNITS: Record<string, string> = {
  weight: 'kg', pressure: 'mmhg', pulse: 'bpm', steps: 'steps',
};
const PROBLEM_KEYS = {
  value: 'HealthFormProblemValue',
  future: 'HealthFormProblemFuture',
  span: 'HealthFormProblemSpan',
  form: 'HealthFormProblemForm',
} as const;
const PLACEHOLDERS: Record<string, string> = { pulse: '64', steps: '8400' };

// Parvane (spec 041; доски `HealthWeight`, `XpHealth`, `RpHealth`): карточка «Записать» подробного экрана — вес
// шагом ±0,1 от последнего значения, давление с пульсом тремя полями, остальное одним числом. Годится ли запись,
// решает движок (`healthCheck`) — теми же диапазонами, что у ввода строкой
const HealthRecordForm = ({ kind, metric }: OwnProps) => {
  const lang = useLang();
  const isWeight = kind === 'weight';
  const isPressure = kind === 'pressure';
  const [value, setValue] = useState('');
  const [value2, setValue2] = useState('');
  const [pulse, setPulse] = useState('');
  const [problem, setProblem] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const last = metric?.last;

  // Вес начинается с последнего значения; поле готово к вводу в кадре появления экрана
  useLayoutEffect(() => {
    setValue(isWeight && last ? formatValue(last, lang.code) : '');
    setValue2('');
    setPulse('');
    setProblem(undefined);
  }, [kind, isWeight, last, lang.code]);

  const handleValue = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value: text } = e.currentTarget;
    if (name === 'value2') setValue2(text);
    else if (name === 'pulse') setPulse(text);
    else setValue(text);
    setProblem(undefined);
  });

  const handleStep = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const current = parseNumber(value) ?? last?.value ?? 0;
    const next = Math.max(0, current + Number(e.currentTarget.dataset.step) * WEIGHT_STEP);
    setValue(formatValue({ kind, value: next, value2: 0 }, lang.code));
  });

  function draftOf(draftKind: string, number: number, number2 = 0): HealthDraft {
    return {
      kind: draftKind,
      atMs: Date.now(),
      endMs: 0,
      tzMin: -new Date().getTimezoneOffset(),
      value: number,
      value2: number2,
      unit: UNITS[draftKind] || metric?.unit || '',
      source: 'manual',
    };
  }

  const handleSubmit = useLastCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    const number = parseNumber(value);
    const number2 = isPressure ? parseNumber(value2) : 0;
    const pulseNumber = isPressure && pulse.trim() ? parseNumber(pulse) : undefined;
    if (number === undefined || number2 === undefined || (pulse.trim() && pulseNumber === undefined)) {
      setProblem('value');
      return;
    }
    const drafts = [draftOf(kind, number, number2)];
    if (pulseNumber !== undefined) drafts.push(draftOf('pulse', pulseNumber));
    setIsSaving(true);
    for (const draft of drafts) {
      const found = await checkHealthEntry(draft);
      if (found) {
        setProblem(found);
        setIsSaving(false);
        return;
      }
    }
    const isAdded = await addHealthEntries(drafts);
    setIsSaving(false);
    if (!isAdded) {
      setProblem('form');
      return;
    }
    if (!isWeight) setValue('');
    setValue2('');
    setPulse('');
  });

  function renderInput(name: string, text: string, label?: string, placeholder?: string) {
    const input = (
      <input
        className={buildClassName(kit.input, styles.recordInput)}
        type="text"
        inputMode="decimal"
        name={name}
        value={text}
        placeholder={placeholder}
        aria-label={label || lang('HealthRecord')}
        autoComplete="off"
        data-health-record-field={name}
        onChange={handleValue}
      />
    );
    if (!label) return input;
    return (
      <label className={styles.field}>
        <span className={buildClassName(kit.muted, kit.small)}>{label}</span>
        {input}
      </label>
    );
  }

  const saveButton = (
    <button
      type="submit"
      className={buildClassName(kit.btn, kit.btnAcc, isPressure && kit.btnWide)}
      disabled={isSaving || !value.trim()}
      data-health-record-save
    >
      {lang('HealthRecord')}
    </button>
  );

  return (
    <form className={styles.recordForm} data-health-record={kind} onSubmit={handleSubmit}>
      {isPressure ? (
        <>
          <div className={styles.fieldRow}>
            {renderInput('value', value, lang('HealthPressureUpper'), '120')}
            {renderInput('value2', value2, lang('HealthPressureLower'), '80')}
            {renderInput('pulse', pulse, lang('HealthKindPulse'), '—')}
          </div>
          {saveButton}
        </>
      ) : (
        <div className={styles.recordRow}>
          {isWeight && (
            <button type="button" className={kit.btn} data-step="-1" data-health-record-step="-" onClick={handleStep}>
              {`−${formatNumber(WEIGHT_STEP, lang.code)}`}
            </button>
          )}
          {renderInput('value', value, undefined, PLACEHOLDERS[kind])}
          {isWeight && (
            <button type="button" className={kit.btn} data-step="1" data-health-record-step="+" onClick={handleStep}>
              {`+${formatNumber(WEIGHT_STEP, lang.code)}`}
            </button>
          )}
          {saveButton}
        </div>
      )}
      {problem && (
        <div className={kit.fieldError} role="alert" data-health-problem={problem}>
          {lang(PROBLEM_KEYS[problem as keyof typeof PROBLEM_KEYS] || PROBLEM_KEYS.form)}
        </div>
      )}
    </form>
  );
};

export default memo(HealthRecordForm);
