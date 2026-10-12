import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { FolderSubmitError, NoteFolder } from './notesFolders';

import buildClassName from '../../../util/buildClassName';
import {
  FOLDER_ERROR_KEYS, FOLDER_NAME_MAX, folderCaption, ROOT_FOLDER,
} from './notesFolders';
import { folderColor } from './notesLook';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  isOpen: boolean;
  noteTitle: string;
  // Путь папки, где заметка лежит сейчас
  currentPath: string;
  folders: NoteFolder[];
  // `folderId` не задан — «Без папки»
  onPick: (folderId?: string) => void;
  // Создать папку и перенести заметку в неё; возвращает причину отказа
  onCreate: (name: string) => Promise<FolderSubmitError | undefined>;
  onClose: NoneToVoidFunction;
};

// Выбор папки для заметки: «Без папки», папки хранилища и «Новая папка…»
const NoteFolderPicker = ({
  isOpen, noteTitle, currentPath, folders, onPick, onCreate, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();

  const [isCreating, startCreating, stopCreating] = useFlag();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [error, setError] = useState<FolderSubmitError>();

  const lang = useLang();

  useEffect(() => {
    if (!isOpen) return;
    stopCreating();
    setError(undefined);
  }, [isOpen]);

  useEffect(() => {
    if (isCreating) inputRef.current?.focus();
  }, [isCreating]);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.folderId || undefined);
  });

  const handleCreate = useLastCallback(async () => {
    const value = (inputRef.current?.value || '').trim();
    if (isBusy) return;
    if (!value) {
      setError('bad-name');
      return;
    }
    markBusy();
    const failure = await onCreate(value);
    unmarkBusy();
    setError(failure);
  });

  const handleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void handleCreate();
  });

  function renderOption(path: string, folderId?: string) {
    const isCurrent = path === currentPath;
    return (
      <button
        key={path}
        type="button"
        className={buildClassName(kit.row, isCurrent && kit.rowSel)}
        aria-current={isCurrent ? 'true' : undefined}
        data-folder-option={path}
        data-folder-id={folderId}
        onClick={handlePick}
      >
        <span className={buildClassName(kit.ava, kit.avaS)} style={`--c: ${folderColor(path)}`} aria-hidden="true">
          <PvIcon name="folder" isSmall />
        </span>
        <span className={buildClassName(kit.rowText, kit.ttl)}>
          {path ? folderCaption(path) : lang('KnowledgeRoot')}
        </span>
        {isCurrent && <PvIcon name="check" isSmall />}
      </button>
    );
  }

  return (
    <PvSheet isOpen={isOpen} title={lang('KnowledgeMoveTitle', { name: noteTitle })} isTight onClose={onClose}>
      <div className={styles.folderPicker} data-folder-picker>
        {renderOption(ROOT_FOLDER)}
        {folders.map((folder) => renderOption(folder.path, folder.id))}
        {isCreating ? (
          <div className={styles.folderForm}>
            <input
              ref={inputRef}
              id="knowledge-move-folder-name"
              className={kit.input}
              maxLength={FOLDER_NAME_MAX}
              placeholder={lang('KnowledgeFolderName')}
              aria-label={lang('KnowledgeFolderName')}
              autoComplete="off"
              onKeyDown={handleKey}
            />
            {error && <p className={kit.fieldError} role="alert">{lang(FOLDER_ERROR_KEYS[error])}</p>}
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              disabled={isBusy}
              data-folder-option-create
              onClick={handleCreate}
            >
              <PvIcon name="plus" isSmall />
              {lang('KnowledgeFolderCreate')}
            </button>
          </div>
        ) : (
          <button type="button" className={kit.row} data-folder-option-new onClick={startCreating}>
            <span className={buildClassName(kit.ava, kit.avaS)} aria-hidden="true">
              <PvIcon name="plus" isSmall />
            </span>
            <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeMoveNewFolder')}</span>
          </button>
        )}
      </div>
    </PvSheet>
  );
};

export default memo(NoteFolderPicker);
