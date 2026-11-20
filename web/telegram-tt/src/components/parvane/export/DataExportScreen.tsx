import { memo, useEffect, useRef, useState } from '../../../lib/teact/teact';

import type { ExportLabels } from './exportModel';
import type { ExportOptions, ExportProgress, ExportResult, ExportStage } from './exportRun';
import type { ExportErrorCode } from './exportZip';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { getExportSections, runDataExport } from './exportRun';
import { createProviderSource } from './exportSource';
import { ExportError } from './exportZip';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './DataExportScreen.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type Phase = 'idle' | 'running' | 'done' | 'error';
type Done = Pick<ExportResult, 'fileName' | 'mediaFailed' | 'cloudFailed'> & { size: number };
type OptionKey = keyof ExportOptions;

const ERROR_KEYS = {
  canceled: 'ParvaneExportErrorCanceled',
  'too-large': 'ParvaneExportErrorTooLarge',
  failed: 'ParvaneExportErrorFailed',
} as const;

// Строки выбора: ключ опции, атрибут для сценариев, название и подпись справа (доска `DkSettingsB`)
const OPTION_ROWS = [
  { key: 'includeChats', mark: 'chats', titleKey: 'ParvaneExportChats', valueKey: 'ParvaneExportChatsFormat' },
  { key: 'includeMedia', mark: 'media', titleKey: 'ParvaneExportMedia', valueKey: 'ParvaneExportMediaFormat' },
  {
    key: 'includePlanner', mark: 'planner', titleKey: 'ParvaneExportPlanner', valueKey: 'ParvaneExportPlannerFormat',
  },
  { key: 'includeNotes', mark: 'notes', titleKey: 'ParvaneExportNotes', valueKey: 'ParvaneExportNotesFormat' },
  { key: 'includeCloud', mark: 'cloud', titleKey: 'ParvaneExportCloud', valueKey: 'ParvaneExportCloudFormat' },
  {
    key: 'includeContacts',
    mark: 'contacts',
    titleKey: 'ParvaneExportContacts',
    valueKey: 'ParvaneExportContactsFormat',
  },
] as const;

const STAGE_KEYS = {
  prepare: 'ParvaneExportStagePrepare',
  chats: 'ParvaneExportChats',
  planner: 'ParvaneExportPlanner',
  notes: 'ParvaneExportNotes',
  contacts: 'ParvaneExportContacts',
  cloud: 'ParvaneExportCloud',
  finishing: 'ParvaneExportStageFinishing',
} as const satisfies Record<ExportStage, string>;

// Адрес архива живёт, пока браузер не заберёт файл: сразу после `click()` отзывать рано
const REVOKE_DELAY_MS = 60000;

const DEFAULT_OPTIONS: ExportOptions = {
  includeChats: true,
  includeMedia: false,
  includePlanner: true,
  includeNotes: true,
  includeCloud: false,
  includeContacts: true,
};

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

// Parvane (spec 041, доска `DkSettingsB`): «Выгрузить мои данные» экраном — разделы галочками, ход выгрузки
// разделом «N из M» с полосой, «Отменить». Всё собирается на устройстве в один ZIP (чаты — HTML и JSON, «План»,
// заметки, контакты, по желанию вложения и файлы диска); архив сохраняется в загрузки браузера. Уход с экрана
// посреди выгрузки — отмена
const DataExportScreen = ({ isActive, onReset }: OwnProps) => {
  const lang = useLang();
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_OPTIONS);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ExportProgress | undefined>();
  const [done, setDone] = useState<Done | undefined>();
  const [error, setError] = useState<ExportErrorCode | undefined>();
  const abortRef = useRef<AbortController>();

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (isActive) return;
    abortRef.current?.abort();
    abortRef.current = undefined;
    setPhase('idle');
    setProgress(undefined);
    setDone(undefined);
    setError(undefined);
  }, [isActive]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isRunning = phase === 'running';
  const hasSections = getExportSections(options).length > 0;

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const key = e.currentTarget.dataset.option as OptionKey;
    const isChecked = e.currentTarget.checked;
    setOptions((current) => ({ ...current, [key]: isChecked }));
  });

  const handleStart = useLastCallback(async () => {
    if (isRunning || !hasSections) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase('running');
    setError(undefined);
    setDone(undefined);
    setProgress(undefined);
    try {
      const result = await runDataExport({
        source: createProviderSource({ drive: lang('ParvaneCloudTabDrive') }),
        options: { ...options, includeMedia: Boolean(options.includeChats && options.includeMedia) },
        labels: buildLabels(lang),
        signal: abort.signal,
        onProgress: setProgress,
      });
      if (abortRef.current !== abort) return;
      saveBlob(result.blob, result.fileName);
      setDone({
        fileName: result.fileName,
        size: result.blob.size,
        mediaFailed: result.mediaFailed,
        cloudFailed: result.cloudFailed,
      });
      setPhase('done');
    } catch (e) {
      if (abortRef.current !== abort) return;
      setError(e instanceof ExportError ? e.code : 'failed');
      setPhase('error');
    } finally {
      if (abortRef.current === abort) abortRef.current = undefined;
    }
  });

  const handleCancel = useLastCallback(() => {
    abortRef.current?.abort();
  });

  const percent = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const missing = done ? done.mediaFailed + done.cloudFailed : 0;
  const stageName = lang(STAGE_KEYS[progress?.stage || 'prepare']);

  return (
    <div
      className={buildClassName('settings-content custom-scroll', styles.screen)}
      data-export-dialog
      data-export-phase={phase}
    >
      <p className={styles.hint}>{lang('ParvaneExportHint')}</p>
      <div className={styles.group}>
        {OPTION_ROWS.map(({
          key, mark, titleKey, valueKey,
        }) => {
          const isMediaOff = key === 'includeMedia' && !options.includeChats;
          return (
            <label key={key} className={styles.row} data-export-option={mark}>
              <input
                type="checkbox"
                className={styles.check}
                data-option={key}
                checked={Boolean(options[key]) && !isMediaOff}
                disabled={isRunning || isMediaOff}
                onChange={handleToggle}
              />
              <span className={styles.title}>{lang(titleKey)}</span>
              <span className={styles.value}>{lang(valueKey)}</span>
            </label>
          );
        })}
      </div>
      <p className={styles.hint}>{lang('ParvaneExportWhere')}</p>

      {isRunning && (
        <div className={styles.card} data-export-progress data-export-stage={progress?.stage || 'prepare'}>
          <div className={styles.progressHead}>
            <span className={styles.title}>{lang('ParvaneExportRunning', { section: stageName })}</span>
            {progress?.section ? (
              <span className={styles.value}>
                {lang('ParvaneExportSectionOf', { done: progress.section, total: progress.sections || 0 })}
              </span>
            ) : undefined}
          </div>
          <div className={styles.bar}>
            <div className={styles.fill} style={`width: ${percent}%`} />
          </div>
          {progress?.bytes ? (
            <p className={styles.hint}>
              {lang('ParvaneExportWritten', { size: formatFileSize(lang, progress.bytes) })}
            </p>
          ) : undefined}
          <span data-export-cancel>
            <button type="button" className={kit.btn} onClick={handleCancel}>{lang('Cancel')}</button>
          </span>
        </div>
      )}

      {done && (
        <div
          className={buildClassName(styles.card, styles.done)}
          data-export-done
          data-export-file-name={done.fileName}
        >
          <p className={styles.doneText}>
            {lang('ParvaneExportDone', { name: done.fileName, size: formatFileSize(lang, done.size) })}
          </p>
          {missing > 0 && (
            <p className={styles.hint} data-export-missing={missing}>
              {lang('ParvaneExportDoneMissing', { count: missing })}
            </p>
          )}
        </div>
      )}
      {error && <p className={styles.error} data-export-error={error}>{lang(ERROR_KEYS[error])}</p>}

      {!isRunning && (
        <span data-export-start>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
            disabled={!hasSections}
            onClick={handleStart}
          >
            {lang('ParvaneExportStart')}
          </button>
        </span>
      )}
    </div>
  );
};

function buildLabels(lang: ReturnType<typeof useLang>): ExportLabels {
  return {
    title: lang('ParvaneExportHtmlTitle'),
    chats: lang('ParvaneExportHtmlChats'),
    planner: lang('ParvaneExportHtmlPlanner'),
    notes: lang('ParvaneExportHtmlNotes'),
    contacts: lang('ParvaneExportHtmlContacts'),
    cloud: lang('ParvaneExportHtmlCloud'),
    savedMessages: lang('SavedMessages'),
    replyTo: lang('ParvaneExportHtmlReplyTo'),
    forwardedFrom: lang('ParvaneExportHtmlForwardedFrom'),
    edited: lang('ParvaneExportHtmlEdited'),
    mediaNotIncluded: lang('ParvaneExportHtmlMediaNotIncluded'),
    mediaUnavailable: lang('ParvaneExportHtmlMediaUnavailable'),
    poll: lang('ParvaneExportHtmlPoll'),
    location: lang('ParvaneExportHtmlLocation'),
    messages: lang('ParvaneExportHtmlMessages'),
    exportedAt: lang('ParvaneExportHtmlExportedAt'),
    privacyOn: lang('ParvaneExportHtmlPrivacyOn'),
    privacyOff: lang('ParvaneExportHtmlPrivacyOff'),
  };
}

export default memo(DataExportScreen);
