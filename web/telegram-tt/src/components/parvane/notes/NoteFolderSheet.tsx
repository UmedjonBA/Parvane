import {
  memo, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { FolderSubmitError, NoteFolder } from './notesFolders';

import buildClassName from '../../../util/buildClassName';
import { FOLDER_ERROR_KEYS, FOLDER_NAME_MAX, folderCaption } from './notesFolders';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import NoteFolderActions from './NoteFolderActions';
import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Папка, которую правят; не задана — создаётся новая
  folder?: NoteFolder;
  // Название новой папки либо новое название папки; возвращает причину отказа, без неё шторка закрывается
  onSubmit: (name: string) => Promise<FolderSubmitError | undefined>;
  onDelete?: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

// Шторка папки заметок: название новой папки либо действия с существующей строками (доска `ZpNotesX`)
const NoteFolderSheet = ({
  isOpen, folder, onSubmit, onDelete, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();

  const [name, setName] = useState('');
  const [error, setError] = useState<FolderSubmitError>();
  const [isBusy, markBusy, unmarkBusy] = useFlag();

  const lang = useLang();

  // Поля ставятся в кадре появления шторки: обычный эффект затирал название, введённое сразу после открытия
  useLayoutEffect(() => {
    if (!isOpen || folder) return;
    setName('');
    setError(undefined);
    inputRef.current?.focus();
  }, [isOpen, folder]);

  const handleName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
    setError(undefined);
  });

  // Название берётся из самого поля: Enter приходит раньше перерисовки с набранным
  const handleSubmit = useLastCallback(async () => {
    const value = (inputRef.current?.value ?? name).trim();
    if (isBusy) return;
    if (!value) {
      setError('bad-name');
      return;
    }
    markBusy();
    const failure = await onSubmit(value);
    unmarkBusy();
    if (failure) setError(failure);
    else onClose();
  });

  const handleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void handleSubmit();
  });

  return (
    <PvSheet
      isOpen={isOpen}
      title={folder ? folderCaption(folder.path) : lang('KnowledgeNewFolder')}
      isTight={Boolean(folder)}
      onClose={onClose}
    >
      {folder ? (
        <div data-folder-sheet="edit">
          <NoteFolderActions folder={folder} onRename={onSubmit} onDelete={onDelete} onDone={onClose} />
        </div>
      ) : (
        <div className={styles.folderForm} data-folder-sheet="create">
          <input
            ref={inputRef}
            id="knowledge-folder-name"
            className={kit.input}
            value={name}
            maxLength={FOLDER_NAME_MAX}
            placeholder={lang('KnowledgeFolderName')}
            aria-label={lang('KnowledgeFolderName')}
            autoComplete="off"
            onChange={handleName}
            onKeyDown={handleKey}
          />
          {error && (
            <p className={kit.fieldError} role="alert" data-folder-error={error}>{lang(FOLDER_ERROR_KEYS[error])}</p>
          )}
          <div className={kit.sheetButtons}>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              disabled={isBusy}
              data-folder-submit
              onClick={handleSubmit}
            >
              <PvIcon name="plus" isSmall />
              {lang('KnowledgeFolderCreate')}
            </button>
          </div>
        </div>
      )}
    </PvSheet>
  );
};

export default memo(NoteFolderSheet);
