import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { FolderSubmitError, NoteFolder } from './notesFolders';

import buildClassName from '../../../util/buildClassName';
import { FOLDER_ERROR_KEYS, FOLDER_NAME_MAX, folderCaption } from './notesFolders';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Папка, которую правят; не задана — создаётся новая
  folder?: NoteFolder;
  // Возвращает причину отказа; без неё шторка закрывается
  onSubmit: (name: string) => Promise<FolderSubmitError | undefined>;
  onDelete?: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

// Шторка папки заметок: название новой папки либо переименование и удаление существующей
const NoteFolderSheet = ({
  isOpen, folder, onSubmit, onDelete, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();

  const [name, setName] = useState('');
  const [error, setError] = useState<FolderSubmitError>();
  const [isBusy, markBusy, unmarkBusy] = useFlag();

  const lang = useLang();

  useEffect(() => {
    if (!isOpen) return;
    setName(folder?.name || '');
    setError(undefined);
    inputRef.current?.focus();
  }, [isOpen, folder?.id, folder?.name]);

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
      onClose={onClose}
    >
      <div className={styles.folderForm} data-folder-sheet={folder ? 'edit' : 'create'}>
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
            <PvIcon name={folder ? 'edit' : 'plus'} isSmall />
            {lang(folder ? 'KnowledgeFolderRename' : 'KnowledgeFolderCreate')}
          </button>
          {folder && onDelete && (
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnDanger)}
              disabled={isBusy}
              data-folder-delete
              onClick={onDelete}
            >
              <PvIcon name="trash" isSmall />
              {lang('KnowledgeFolderDelete')}
            </button>
          )}
        </div>
      </div>
    </PvSheet>
  );
};

export default memo(NoteFolderSheet);
