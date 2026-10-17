import { memo, useEffect, useRef, useState } from '../../../lib/teact/teact';

import type { ExportLabels } from './exportModel';
import type { ExportOptions, ExportProgress, ExportResult } from './exportRun';
import type { ExportErrorCode } from './exportZip';

import { formatFileSize } from '../../../util/textFormat';
import { runDataExport } from './exportRun';
import { createProviderSource } from './exportSource';
import { ExportError } from './exportZip';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import Modal from '../../ui/Modal';

import styles from './DataExportModal.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

type Phase = 'idle' | 'running' | 'done' | 'error';
type Done = Pick<ExportResult, 'fileName' | 'mediaFailed' | 'cloudFailed'> & { size: number };

const ERROR_KEYS = {
  canceled: 'ParvaneExportErrorCanceled',
  'too-large': 'ParvaneExportErrorTooLarge',
  failed: 'ParvaneExportErrorFailed',
} as const;

// Адрес архива живёт, пока браузер не заберёт файл: сразу после `click()` отзывать рано
const REVOKE_DELAY_MS = 60000;

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

// «Выгрузка данных»: всё на устройстве в один ZIP — чаты (HTML + JSON) с медиа по желанию, «План», заметки,
// контакты и по отдельной галочке файлы облака. Ход, отмена, итог — здесь же; архив скачивается сам
const DataExportModal = ({ isOpen, onClose }: OwnProps) => {
  const lang = useLang();
  const [options, setOptions] = useState<ExportOptions>({ includeMedia: true, includeCloud: false });
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ExportProgress | undefined>();
  const [done, setDone] = useState<Done | undefined>();
  const [error, setError] = useState<ExportErrorCode | undefined>();
  const abortRef = useRef<AbortController>();

  // Закрытие окна посреди выгрузки — та же отмена; поля чистятся при закрытии
  useEffect(() => {
    if (isOpen) return;
    abortRef.current?.abort();
    abortRef.current = undefined;
    setPhase('idle');
    setProgress(undefined);
    setDone(undefined);
    setError(undefined);
  }, [isOpen]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleMedia = useLastCallback((isChecked: boolean) => {
    setOptions((current) => ({ ...current, includeMedia: isChecked }));
  });
  const handleCloud = useLastCallback((isChecked: boolean) => {
    setOptions((current) => ({ ...current, includeCloud: isChecked }));
  });

  const handleStart = useLastCallback(async () => {
    if (phase === 'running') return;
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase('running');
    setError(undefined);
    setDone(undefined);
    setProgress(undefined);
    const labels: ExportLabels = {
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
    try {
      const result = await runDataExport({
        source: createProviderSource({ drive: lang('ParvaneCloudTabDrive') }),
        options,
        labels,
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
    if (phase === 'running') {
      abortRef.current?.abort();
      return;
    }
    onClose();
  });

  const isRunning = phase === 'running';
  const stageText = progress && (() => {
    const vars = { done: progress.done, total: progress.total };
    switch (progress.stage) {
      case 'chats': return lang('ParvaneExportStageChats', vars);
      case 'planner': return lang('ParvaneExportStagePlanner');
      case 'notes': return lang('ParvaneExportStageNotes', vars);
      case 'contacts': return lang('ParvaneExportStageContacts');
      case 'cloud': return lang('ParvaneExportStageCloud', vars);
      case 'finishing': return lang('ParvaneExportStageFinishing');
      default: return lang('ParvaneExportStagePrepare');
    }
  })();
  const percent = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const missing = done ? done.mediaFailed + done.cloudFailed : 0;

  return (
    <Modal isOpen={isOpen} onClose={handleCancel} title={lang('ParvaneExportTitle')} className={styles.root}>
      <div data-export-dialog data-export-phase={phase}>
        <p className={styles.hint}>{lang('ParvaneExportHint')}</p>
        <div data-export-option="media">
          <Checkbox
            label={lang('ParvaneExportMedia')}
            checked={options.includeMedia}
            disabled={isRunning}
            onCheck={handleMedia}
          />
        </div>
        <div data-export-option="cloud">
          <Checkbox
            label={lang('ParvaneExportCloud')}
            subLabel={lang('ParvaneExportCloudHint')}
            checked={options.includeCloud}
            disabled={isRunning}
            onCheck={handleCloud}
          />
        </div>
        {isRunning && (
          <div className={styles.progress} data-export-progress data-export-stage={progress?.stage || 'prepare'}>
            <div className={styles.bar}>
              <div className={styles.fill} style={`width: ${percent}%`} />
            </div>
            <p className={styles.note}>{stageText || lang('ParvaneExportStagePrepare')}</p>
            {Boolean(progress?.bytes) && (
              <p className={styles.note}>
                {lang('ParvaneExportWritten', { size: formatFileSize(lang, progress.bytes) })}
              </p>
            )}
          </div>
        )}
        {done && (
          <div className={styles.done} data-export-done data-export-file-name={done.fileName}>
            <p>{lang('ParvaneExportDone', { name: done.fileName, size: formatFileSize(lang, done.size) })}</p>
            {missing > 0 && (
              <p className={styles.note} data-export-missing={missing}>
                {lang('ParvaneExportDoneMissing', { count: missing })}
              </p>
            )}
          </div>
        )}
        {error && <p className={styles.error} data-export-error={error}>{lang(ERROR_KEYS[error])}</p>}
        <div className={styles.buttons}>
          <span data-export-cancel>
            <Button color="translucent" onClick={handleCancel}>
              {lang(isRunning ? 'Cancel' : 'Close')}
            </Button>
          </span>
          <span data-export-start>
            <Button onClick={handleStart} disabled={isRunning} isLoading={isRunning}>
              {lang('ParvaneExportStart')}
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
};

export default memo(DataExportModal);
