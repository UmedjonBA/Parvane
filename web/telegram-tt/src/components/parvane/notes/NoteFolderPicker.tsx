import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
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
import extra from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  // Телефон: страница во весь экран с «✕» слева (доска `ZpNotesX`)
  isNarrow?: boolean;
  isOpen: boolean;
  noteTitle: string;
  // Путь папки, где заметка лежит сейчас
  currentPath: string;
  folders: NoteFolder[];
  // Заметки хранилища: число заметок у каждой папки
  notes: { folder: string }[];
  // `folderId` не задан — «Без папки»
  onPick: (folderId?: string) => void;
  // Создать папку и перенести заметку в неё; возвращает причину отказа
  onCreate: (name: string) => Promise<FolderSubmitError | undefined>;
  onClose: NoneToVoidFunction;
};

type Option = { path: string; folderId?: string; caption: string; isDaily: boolean };

// Перенос заметки в папку (доска `ZpNotesX`): поиск по названию, папки со счётчиком заметок («Ежедневные» —
// первой, «Без папки» — последней), у текущей подпись «заметка сейчас здесь». Выбор в два шага: строка
// отмечается, перенос — кнопкой «Перенести в «…»»; «Новая папка» создаёт папку и переносит сразу
const NoteFolderPicker = ({
  isOpen, noteTitle, currentPath, folders, notes, isNarrow, onPick, onCreate, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();

  const [query, setQuery] = useState('');
  const [pickedPath, setPickedPath] = useState(currentPath);
  const [isCreating, startCreating, stopCreating] = useFlag();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [error, setError] = useState<FolderSubmitError>();

  const lang = useLang();
  const dailyName = lang('KnowledgeDailyFolder');

  // Состояние ставится в кадре появления шторки: выбор сразу после открытия не перебивается
  useLayoutEffect(() => {
    if (!isOpen) return;
    stopCreating();
    setError(undefined);
    setQuery('');
    setPickedPath(currentPath);
  }, [isOpen, currentPath]);

  useEffect(() => {
    if (isCreating) inputRef.current?.focus();
  }, [isCreating]);

  // Заметки прямо в папке (без подпапок), как счётчик строки папки в списке
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    notes.forEach(({ folder }) => result.set(folder, (result.get(folder) || 0) + 1));
    return result;
  }, [notes]);

  const options = useMemo(() => {
    const list: Option[] = folders.map(({ id, path }) => ({
      path, folderId: id, caption: folderCaption(path), isDaily: path === dailyName,
    }));
    const daily = list.filter(({ isDaily }) => isDaily);
    const rest = list.filter(({ isDaily }) => !isDaily);
    const root: Option = {
      path: ROOT_FOLDER, caption: lang('KnowledgeRoot'), isDaily: false,
    };
    const key = query.trim().toLowerCase();
    return [...daily, ...rest, root].filter(({ caption }) => !key || caption.toLowerCase().includes(key));
  }, [folders, dailyName, lang, query]);

  const picked = pickedPath === ROOT_FOLDER ? undefined : folders.find(({ path }) => path === pickedPath);
  const pickedCaption = picked ? folderCaption(picked.path) : lang('KnowledgeRoot');

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handleSelect = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPickedPath(e.currentTarget.dataset.folderOption || ROOT_FOLDER);
  });

  const handleMove = useLastCallback(() => {
    if (pickedPath === currentPath) return;
    onPick(picked?.id);
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

  function renderOption({
    path, folderId, caption, isDaily,
  }: Option) {
    const isCurrent = path === currentPath;
    const isPicked = path === pickedPath;
    return (
      <button
        key={path}
        type="button"
        className={buildClassName(kit.row, isPicked && kit.rowSel)}
        aria-pressed={isPicked}
        aria-current={isCurrent ? 'true' : undefined}
        data-folder-option={path}
        data-folder-id={folderId}
        onClick={handleSelect}
      >
        <span
          className={buildClassName(kit.ava, kit.avaS)}
          style={`--c: ${folderColor(path, isDaily)}`}
          aria-hidden="true"
        >
          <PvIcon name="folder" isSmall />
        </span>
        <span className={kit.rowText}>
          <span className={kit.ttl}>{caption}</span>
          {isCurrent && <span className={kit.sub} data-folder-here>{lang('KnowledgeMoveHere')}</span>}
        </span>
        <span className={kit.meta} data-folder-option-count>{counts.get(path) || 0}</span>
        <span className={buildClassName(extra.pickBox, isPicked && extra.pickBoxOn)} aria-hidden="true">
          {isPicked && <PvIcon name="check" isSmall />}
        </span>
      </button>
    );
  }

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('KnowledgeMoveTitle')}
      subtitle={`«${noteTitle}»`}
      isTight
      isPage
      startClose={isNarrow ? 'cancel' : undefined}
      onClose={onClose}
    >
      <div className={styles.folderPicker} data-folder-picker>
        <label className={extra.pickSearch}>
          <span className={extra.pickSearchLabel}>{lang('KnowledgeMoveSearch')}</span>
          <input
            className={kit.input}
            value={query}
            placeholder={lang('KnowledgeFolderName')}
            aria-label={lang('KnowledgeMoveSearch')}
            autoComplete="off"
            data-folder-search
            onChange={handleQuery}
          />
        </label>
        {options.map(renderOption)}
        {isCreating && (
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
        )}
        <div className={extra.pickButtons}>
          {!isCreating && (
            <button type="button" className={kit.btn} data-folder-option-new onClick={startCreating}>
              {lang('KnowledgeMoveNewFolder')}
            </button>
          )}
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={pickedPath === currentPath}
            data-folder-move={pickedPath}
            onClick={handleMove}
          >
            {lang('KnowledgeMoveTo', { name: pickedCaption })}
          </button>
        </div>
      </div>
    </PvSheet>
  );
};

export default memo(NoteFolderPicker);
