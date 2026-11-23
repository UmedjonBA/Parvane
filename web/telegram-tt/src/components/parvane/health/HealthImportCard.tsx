import { memo, useRef, useState } from '../../../lib/teact/teact';

import type {
  createHealthImport, HealthImportError, HealthImportPreview,
} from '../../../api/parvane/healthImport';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { refreshHealth } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from '../planner/PlannerSettings.module.scss';

type ImportMethods = ReturnType<typeof createHealthImport>;
const callImport = callApi as unknown as <N extends keyof ImportMethods>(
  name: N, ...args: Parameters<ImportMethods[N]>
) => ReturnType<ImportMethods[N]>;

type State =
  | { step: 'idle' }
  | { step: 'reading' }
  | { step: 'preview'; preview: HealthImportPreview }
  | { step: 'writing'; total: number }
  | { step: 'done'; added: number }
  | { step: 'error'; error: HealthImportError };

// Виды в порядке показа и их подписи в предпросмотре
const KINDS = [
  'steps', 'sleep', 'pulse', 'weight', 'pressure', 'workout', 'water', 'temperature', 'spo2', 'body_fat', 'height',
] as const;
const KIND_KEYS = {
  steps: 'HealthImportSteps',
  sleep: 'HealthImportSleep',
  pulse: 'HealthImportPulse',
  weight: 'HealthImportWeight',
  pressure: 'HealthImportPressure',
  workout: 'HealthImportWorkouts',
  water: 'HealthImportWater',
  temperature: 'HealthImportTemperature',
  spo2: 'HealthImportSpo2',
  body_fat: 'HealthImportBodyFat',
  height: 'HealthImportHeight',
} as const;
const ERROR_KEYS = {
  not_export: 'HealthImportNotExport',
  corrupt: 'HealthImportCorrupt',
  too_big: 'HealthImportTooBig',
  engine: 'HealthImportFailed',
} as const;
const DAY_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

// Импорт «Здоровья» из выгрузки Health Connect (Android): файл выбирается здесь, разбирает движок на устройстве,
// записи без дублей (повторный импорт добавляет только новое). Сначала — что и сколько будет добавлено
const HealthImportCard = () => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const [state, setState] = useState<State>({ step: 'idle' });

  const handlePick = useLastCallback(() => inputRef.current?.click());

  const handleFile = useLastCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setState({ step: 'reading' });
    const result = await callImport('parvaneHealthImportPreview', { file })
      .catch(() => ({ error: 'engine' as const }));
    setState('error' in result ? { step: 'error', error: result.error } : { step: 'preview', preview: result });
  });

  const handleApply = useLastCallback(async () => {
    if (state.step !== 'preview') return;
    setState({ step: 'writing', total: state.preview.total });
    const added = await callImport('parvaneHealthImportApply', { token: state.preview.token }).catch(() => undefined);
    if (added === undefined) {
      setState({ step: 'error', error: 'engine' });
      return;
    }
    void refreshHealth();
    setState({ step: 'done', added });
  });

  const handleCancel = useLastCallback(() => {
    void callImport('parvaneHealthImportCancel');
    setState({ step: 'idle' });
  });

  function formatDay(day: string) {
    return new Intl.DateTimeFormat(lang.code, DAY_FORMAT).format(new Date(`${day}T12:00:00Z`));
  }

  function renderPreview(preview: HealthImportPreview) {
    if (!preview.total) {
      return (
        <div className={styles.row}>
          <p className={styles.hint} data-health-import-empty>{lang('HealthImportNothingNew')}</p>
        </div>
      );
    }
    return (
      <>
        {preview.firstDay && preview.lastDay && (
          <div className={styles.row}>
            <p className={styles.hint}>
              {lang('HealthImportRange', { from: formatDay(preview.firstDay), to: formatDay(preview.lastDay) })}
            </p>
          </div>
        )}
        {KINDS.filter((kind) => preview.counts[kind]).map((kind) => (
          <div key={kind} className={styles.row} data-health-import-kind={kind}>
            <span className={styles.label}>{lang(KIND_KEYS[kind])}</span>
            <span className={kit.mono}>{preview.counts[kind]}</span>
          </div>
        ))}
        <div className={buildClassName(styles.row, styles.importActions)}>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            data-health-import-apply
            onClick={handleApply}
          >
            {lang('HealthImportApply', { count: preview.total }, { pluralValue: preview.total })}
          </button>
          <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={handleCancel}>
            {lang('Cancel')}
          </button>
        </div>
      </>
    );
  }

  function renderNote(text: string, mark?: string) {
    return (
      <div className={styles.row}>
        <p className={styles.hint} data-health-import-note={mark}>{text}</p>
      </div>
    );
  }

  return (
    <div className={styles.card} data-health-import={state.step}>
      <div className={styles.row}>
        <span className={styles.text}>
          <span className={styles.label}>{lang('HealthImportTitle')}</span>
          <span className={styles.sub}>{lang('HealthImportHint')}</span>
        </span>
        {(state.step === 'idle' || state.step === 'done' || state.step === 'error') && (
          <button type="button" className={kit.btn} data-health-import-pick onClick={handlePick}>
            {lang('HealthImportPick')}
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.db,application/zip,application/x-sqlite3"
        className={styles.fileInput}
        data-health-import-file
        onChange={handleFile}
      />
      {state.step === 'reading' && renderNote(lang('HealthImportReading'))}
      {state.step === 'writing' && renderNote(
        lang('HealthImportWriting', { count: state.total }, { pluralValue: state.total }),
      )}
      {state.step === 'preview' && renderPreview(state.preview)}
      {state.step === 'done' && renderNote(
        lang('HealthImportDone', { count: state.added }, { pluralValue: state.added }), 'done',
      )}
      {state.step === 'error' && (
        <div className={styles.row}>
          <p className={kit.fieldError} role="alert" data-health-import-error={state.error}>
            {lang(ERROR_KEYS[state.error])}
          </p>
        </div>
      )}
    </div>
  );
};

export default memo(HealthImportCard);
