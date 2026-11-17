import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { HealthDraft, HealthEntry } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  buildSleepSpan, formatClock, fromLocalParts, parseClock, parseNumber, toLocalParts,
} from './healthFormat';
import {
  addHealthEntries, checkHealthEntry, deleteHealthEntry, saveHealthEntry,
} from './healthStore';
import useHealthLabels from './useHealthLabels';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

// Что открыто в окне: правка записи либо новый дневной сон на этот день
export type HealthSheetTarget = { entry?: HealthEntry; napDay?: string };

type OwnProps = {
  target?: HealthSheetTarget;
  today: string;
  onClose: NoneToVoidFunction;
};

type Form = {
  value: string;
  value2: string;
  day: string;
  time: string;
  endTime: string;
  note: string;
};

const EMPTY_FORM: Form = {
  value: '', value2: '', day: '', time: '', endTime: '', note: '',
};
const NAP_FROM = '14:00';
const NAP_TO = '15:00';
const NOTE_MAX = 500;
const PROBLEM_KEYS = {
  value: 'HealthFormProblemValue',
  future: 'HealthFormProblemFuture',
  span: 'HealthFormProblemSpan',
  form: 'HealthFormProblemForm',
} as const;

// Parvane (spec 038, 041; доски `ZpHealthX`, `ZdHealthX`): окно правки записи и дневного сна. Поля зависят
// от вида: значение (у давления — два), отрезок сна «с — до» по дню пробуждения, длительность либо только
// время отметки. Годится ли запись, решает движок (`healthCheck`) — теми же диапазонами, что у ввода строкой
const HealthEntrySheet = ({ target, today, onClose }: OwnProps) => {
  const {
    lang, kindTitle, unitTitle, duration,
  } = useHealthLabels(today);
  const shown = useCurrentOrPrev(target);
  const entry = shown?.entry;
  const kind = entry?.kind || 'sleep';
  const isSleep = kind === 'sleep';
  const isSpan = isSleep && (!entry || entry.endMs > entry.atMs);
  const isDuration = isSleep && !isSpan;
  const isMark = kind === 'sleep_start' || kind === 'sleep_end';
  const hasSecondValue = kind === 'pressure';

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [problem, setProblem] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  // Пояс записи; у нового сна — пояс устройства на момент открытия окна
  const [tzMin, setTzMin] = useState(0);

  useEffect(() => {
    if (!target) return;
    setProblem(undefined);
    setIsSaving(false);
    const { entry: opened, napDay } = target;
    setTzMin(opened ? opened.tzMin : -new Date().getTimezoneOffset());
    if (!opened) {
      setForm({
        ...EMPTY_FORM, day: napDay || today, time: NAP_FROM, endTime: NAP_TO,
      });
      return;
    }
    const start = toLocalParts(opened.atMs, opened.tzMin);
    const end = opened.endMs ? toLocalParts(opened.endMs, opened.tzMin) : undefined;
    setForm({
      value: opened.kind === 'sleep' ? formatClock(opened.value) : String(opened.value),
      value2: String(opened.value2),
      day: (end || start).day,
      time: start.time,
      endTime: end ? end.time : '',
      note: opened.note,
    });
  }, [target, today]);

  const handleField = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.currentTarget;
    setForm((current) => ({ ...current, [name]: value }));
    setProblem(undefined);
  });

  const span = isSpan ? buildSleepSpan(form.day, form.time, form.endTime, tzMin) : undefined;

  function buildDraft(): HealthDraft | undefined {
    const base = {
      kind,
      tzMin,
      endMs: 0,
      value: 0,
      value2: 0,
      unit: entry ? entry.unit : 'min',
      source: entry?.source || 'manual',
      note: form.note.trim(),
    };
    if (isSpan) {
      return span && {
        ...base, atMs: span.atMs, endMs: span.endMs, value: span.minutes,
      };
    }
    // Сон одной длительностью хранит момент начала дня: меняется только день
    const atMs = fromLocalParts(form.day, isDuration ? toLocalParts(entry!.atMs, tzMin).time : form.time, tzMin);
    if (atMs === undefined) return undefined;
    if (isMark) return { ...base, atMs };
    const value = isDuration ? parseClock(form.value) : parseNumber(form.value);
    const value2 = hasSecondValue ? parseNumber(form.value2) : 0;
    if (value === undefined || value2 === undefined) return undefined;
    return {
      ...base, atMs, value, value2,
    };
  }

  const handleSave = useLastCallback(async () => {
    if (isSaving) return;
    const draft = buildDraft();
    if (!draft) {
      setProblem(isSpan || isMark ? 'form' : 'value');
      return;
    }
    setIsSaving(true);
    const found = await checkHealthEntry(draft);
    if (found) {
      setProblem(found);
      setIsSaving(false);
      return;
    }
    if (entry) {
      await saveHealthEntry(entry.id, draft);
    } else if (!await addHealthEntries([draft])) {
      setProblem('form');
      setIsSaving(false);
      return;
    }
    onClose();
  });

  const handleDelete = useLastCallback(() => {
    void deleteHealthEntry(entry!.id);
    onClose();
  });

  const unit = entry && unitTitle(entry.unit);
  const valueLabel = unit ? `${kindTitle(kind)}, ${unit}` : kindTitle(kind);

  function renderField(name: keyof Form, label: string, type: string, extra?: { max?: string; inputMode?: 'decimal' }) {
    return (
      <label className={styles.field}>
        <span className={buildClassName(kit.muted, kit.small)}>{label}</span>
        <input
          className={kit.input}
          type={type}
          name={name}
          value={form[name]}
          max={extra?.max}
          inputMode={extra?.inputMode}
          maxLength={name === 'note' ? NOTE_MAX : undefined}
          data-health-field={name}
          autoComplete="off"
          onChange={handleField}
        />
      </label>
    );
  }

  return (
    <PvSheet
      isOpen={Boolean(target)}
      title={entry ? lang('HealthEntryEditTitle', { name: kindTitle(kind) }) : lang('HealthNapTitle')}
      onClose={onClose}
      onEnter={handleSave}
    >
      <div className={styles.fields} data-health-sheet={kind}>
        {!isSleep && !isMark && (
          <div className={styles.fieldRow}>
            {renderField('value', hasSecondValue ? lang('HealthPressureUpper') : valueLabel, 'text', {
              inputMode: 'decimal',
            })}
            {hasSecondValue && renderField('value2', lang('HealthPressureLower'), 'text', { inputMode: 'decimal' })}
          </div>
        )}
        {isDuration && renderField('value', lang('HealthSleepDuration'), 'time')}
        <div className={styles.fieldRow}>
          {renderField('day', lang(isSpan ? 'HealthSleepWakeDay' : 'HealthFieldDate'), 'date', { max: today })}
          {!isSpan && !isDuration && renderField('time', lang('HealthFieldTime'), 'time')}
        </div>
        {isSpan && (
          <div className={styles.fieldRow}>
            {renderField('time', lang('HealthSleepFrom'), 'time')}
            {renderField('endTime', lang('HealthSleepTo'), 'time')}
          </div>
        )}
        {span && (
          <div className={kit.muted} data-health-span>
            {lang('HealthSleepDurationValue', { duration: duration(span.minutes) })}
          </div>
        )}
        {renderField('note', lang('HealthFieldNote'), 'text')}
        {problem && (
          <div className={kit.fieldError} role="alert" data-health-problem={problem}>
            {lang(PROBLEM_KEYS[problem as keyof typeof PROBLEM_KEYS] || PROBLEM_KEYS.form)}
          </div>
        )}
      </div>
      <div className={kit.sheetButtons}>
        {entry && (
          <button type="button" className={buildClassName(kit.btn, kit.btnDanger)} onClick={handleDelete}>
            {lang('HealthEntryDelete')}
          </button>
        )}
        <span className={kit.grow} />
        <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          disabled={isSaving}
          data-health-save
          onClick={handleSave}
        >
          {lang(entry ? 'Save' : 'HealthNapAdd')}
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(HealthEntrySheet);
