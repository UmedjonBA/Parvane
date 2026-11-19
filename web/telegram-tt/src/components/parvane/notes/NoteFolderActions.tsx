import { memo, useState } from '../../../lib/teact/teact';

import type { FolderSubmitError, NoteFolder } from './notesFolders';

import buildClassName from '../../../util/buildClassName';
import { FOLDER_ERROR_KEYS, folderCaption } from './notesFolders';
import { FOLDER_TONES } from './notesMeta';
import {
  changeNotesMeta, getNoteFolders, getNotesMeta, nestNoteFolder,
} from './notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  folder: NoteFolder;
  onDone: NoneToVoidFunction;
};

// «Другие действия с папкой» (доска `ZpNotesX`): цвет папки (у верхних папок — цвет на всех экранах) и «Вложить в
// другую папку»
const NoteFolderActions = ({ folder, onDone }: OwnProps) => {
  const lang = useLang();
  const meta = useDerivedState(getNotesMeta);
  const folders = useDerivedState(getNoteFolders);
  const [isNesting, startNesting, stopNesting] = useFlag();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [error, setError] = useState<FolderSubmitError>();
  const isTop = !folder.path.includes('/');
  const tone = meta.tones[folder.id];
  // Куда можно вложить: не в саму себя и не в свои подпапки
  const targets = folders.filter(({ path }) => path !== folder.path && !path.startsWith(`${folder.path}/`));

  const handleTone = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const next = e.currentTarget.dataset.tone;
    void changeNotesMeta({
      kind: 'tone', folder: folder.id, tone: FOLDER_TONES.find((item) => item === next),
    });
  });

  const handleNest = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isBusy) return;
    markBusy();
    const failure = await nestNoteFolder(folder.id, e.currentTarget.dataset.folderId || undefined);
    unmarkBusy();
    setError(failure);
    if (!failure) onDone();
  });

  return (
    <div className={styles.folderActions} data-folder-actions>
      {isTop && (
        <div className={styles.toneRow}>
          <span className={styles.toneLabel}>{lang('KnowledgeFolderColor')}</span>
          <button
            type="button"
            className={buildClassName(styles.tone, styles.toneAuto, !tone && styles.toneOn)}
            aria-label={lang('KnowledgeFolderColorAuto')}
            title={lang('KnowledgeFolderColorAuto')}
            aria-pressed={!tone}
            data-tone=""
            onClick={handleTone}
          />
          {FOLDER_TONES.map((item) => (
            <button
              key={item}
              type="button"
              className={buildClassName(styles.tone, item === tone && styles.toneOn)}
              style={`--c: var(--pv-${item})`}
              aria-label={`${lang('KnowledgeFolderColor')} ${item}`}
              aria-pressed={item === tone}
              data-tone={item}
              onClick={handleTone}
            />
          ))}
        </div>
      )}
      <button type="button" className={kit.row} data-folder-nest onClick={isNesting ? stopNesting : startNesting}>
        <PvIcon name="move" isSmall />
        <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeFolderNest')}</span>
      </button>
      {isNesting && (
        <div className={styles.folderList} data-folder-nest-list>
          {folder.path.includes('/') && (
            <button type="button" className={kit.row} disabled={isBusy} data-folder-nest-target="" onClick={handleNest}>
              <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeFolderNestTop')}</span>
            </button>
          )}
          {targets.map((target) => (
            <button
              key={target.id}
              type="button"
              className={kit.row}
              disabled={isBusy}
              data-folder-id={target.id}
              data-folder-nest-target={target.path}
              onClick={handleNest}
            >
              <span className={buildClassName(kit.rowText, kit.ttl)}>{folderCaption(target.path)}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className={kit.fieldError} role="alert">{lang(FOLDER_ERROR_KEYS[error])}</p>}
    </div>
  );
};

export default memo(NoteFolderActions);
