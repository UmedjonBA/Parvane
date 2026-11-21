import { memo, useEffect, useRef } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { MusicUploadOutcome } from './musicUpload';

import buildClassName from '../../../../util/buildClassName';
import { getMusicInfo } from '../musicPlayer';
import { isAudioFileName, uploadMusicFiles } from './musicUpload';

import useDerivedState from '../../../../hooks/useDerivedState';
import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ParvaneIcon from '../../../main/ParvaneIcon';
import { formatMusicSize } from '../MusicSize';

import kit from '../../notes/PvKit.module.scss';
import styles from './MusicFetch.module.scss';

type OwnProps = {
  // Файлы можно перетащить в окно «Музыки» (`#ParvaneMusic`); нет — только кнопка
  canDropOnWindow?: boolean;
  // Строкой-карточкой (пустая библиотека) либо кнопкой
  isCompact?: boolean;
};

const DROP_TARGET_ID = 'ParvaneMusic';
const ACCEPT = 'audio/*,.mp3,.flac,.ogg,.oga,.opus,.m4a,.wav';
const OUTCOME_KEYS = {
  duplicate: 'MusicUploadDuplicate',
  'not-audio': 'MusicUploadNotAudio',
  'too-big': 'MusicUploadTooBig',
  limit: 'MusicFetchLimit',
  failed: 'MusicUploadFailed',
} as const satisfies Record<Exclude<MusicUploadOutcome, 'ok'>, string>;

// Parvane (spec 041, доски `RpMusicB`, `ZdMusicX`): «Загрузить свои файлы — или перетащите их в это окно — Выбрать».
// Файлы уходят по одному; ход и итог — в «Загрузках на сервер», здесь — короткое уведомление об отказах
const MusicUploadFiles = ({ canDropOnWindow, isCompact }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const info = useDerivedState(getMusicInfo);
  const inputRef = useRef<HTMLInputElement>();
  const [isOver, markOver, unmarkOver] = useFlag();

  const runUpload = useLastCallback(async (files: File[]) => {
    if (!files.length) return;
    showNotification({ message: lang('MusicUploadStarted', { count: files.length }, { pluralValue: files.length }) });
    const outcomes = await uploadMusicFiles(files);
    const failed = outcomes.filter((outcome) => outcome !== 'ok');
    if (!failed.length) return;
    const first = failed[0];
    showNotification({
      message: first === 'too-big'
        ? lang('MusicUploadTooBig', { size: String(formatMusicSize(lang, info?.uploadMaxBytes || 0)) })
        : lang(OUTCOME_KEYS[first]),
    });
  });

  const handlePick = useLastCallback(() => inputRef.current?.click());
  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files || []);
    e.currentTarget.value = '';
    void runUpload(files);
  });

  useEffect(() => {
    const dropTarget = canDropOnWindow ? document.getElementById(DROP_TARGET_ID) : undefined;
    if (!dropTarget || !info?.isUploadEnabled) return undefined;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    const handleOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      markOver();
    };
    const handleLeave = (e: DragEvent) => {
      if (e.target === dropTarget) unmarkOver();
    };
    const handleDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      unmarkOver();
      void runUpload(Array.from(e.dataTransfer!.files).filter((file) => isAudioFileName(file.name)));
    };
    dropTarget.addEventListener('dragover', handleOver);
    dropTarget.addEventListener('dragleave', handleLeave);
    dropTarget.addEventListener('drop', handleDrop);
    return () => {
      dropTarget.removeEventListener('dragover', handleOver);
      dropTarget.removeEventListener('dragleave', handleLeave);
      dropTarget.removeEventListener('drop', handleDrop);
    };
  }, [canDropOnWindow, info?.isUploadEnabled, markOver, runUpload, unmarkOver]);

  if (!info?.isUploadEnabled) return undefined;

  const input = (
    <input
      ref={inputRef}
      className={styles.fileInput}
      type="file"
      accept={ACCEPT}
      multiple
      data-music-upload-input
      onChange={handleChange}
    />
  );

  if (isCompact) {
    return (
      <>
        <button type="button" className={kit.btn} data-music-upload onClick={handlePick}>
          <ParvaneIcon name="upload" isSmall />
          {lang('MusicUploadOwn')}
        </button>
        {input}
      </>
    );
  }

  return (
    <div className={buildClassName(styles.uploadCard, isOver && styles.dropActive)} data-music-upload-card>
      <ParvaneIcon name="upload" />
      <span className={styles.text}>
        <span className={styles.title}>{lang('MusicUploadOwn')}</span>
        <span className={styles.sub}>{lang('MusicUploadOwnHint')}</span>
      </span>
      <button type="button" className={kit.btn} data-music-upload onClick={handlePick}>
        {lang('MusicUploadPick')}
      </button>
      {input}
    </div>
  );
};

export default memo(MusicUploadFiles);
