import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { NoteFolder } from './notesFolders';
import type { NotesIndex } from './notesModel';

import buildClassName from '../../../util/buildClassName';
import { folderCaption } from './notesFolders';
import { normalizeNoteTitle } from './notesModel';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from './PvSheet';

import styles from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  // Название заметки из ссылки `[[…]]`; не задано — шторка закрыта
  title?: string;
  index: NotesIndex;
  folders: NoteFolder[];
  // Папка, в которую заметка встанет по умолчанию (папка заметки со ссылкой); не задана — «Без папки»
  folderId?: string;
  onCreate: (title: string, folderId?: string) => void;
  onClose: NoneToVoidFunction;
};

// Ссылка на заметку, которой ещё нет (доска `RpNotes`): сначала вопрос — кто на неё ссылается, название и папка,
// «Создать и открыть» либо «Не сейчас»
const NoteMissingSheet = ({
  title, index, folders, folderId, onCreate, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [name, setName] = useState('');
  const [pickedId, setPickedId] = useState<string>();
  const [isPicking, startPicking, stopPicking] = useFlag();

  useEffect(() => {
    if (title === undefined) return;
    setName(title);
    setPickedId(folderId);
    stopPicking();
  }, [title, folderId]);

  const sources = useMemo(() => {
    if (title === undefined) return [];
    const key = normalizeNoteTitle(title);
    const fromIds = index.unresolved.find((item) => normalizeNoteTitle(item.title) === key)?.fromIds || [];
    return fromIds.map((id) => index.byId(id)?.title).filter(Boolean);
  }, [index, title]);

  const picked = folders.find(({ id }) => id === pickedId);

  const handleName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const handlePickFolder = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPickedId(e.currentTarget.dataset.folderId || undefined);
    stopPicking();
  });

  const handleCreate = useLastCallback(() => {
    const clean = name.trim();
    if (!clean) return;
    onCreate(clean, pickedId);
  });

  const handleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleCreate();
  });

  function renderFolderOption(id: string | undefined, caption: string) {
    return (
      <button
        key={id || ''}
        type="button"
        className={buildClassName(kit.row, id === pickedId && kit.rowSel)}
        data-folder-id={id}
        data-missing-folder-option={caption}
        onClick={handlePickFolder}
      >
        <span className={buildClassName(kit.rowText, kit.ttl)}>{caption}</span>
      </button>
    );
  }

  return (
    <PvSheet
      isOpen={title !== undefined}
      title={lang('KnowledgeMissingTitle', { name: title || '' })}
      onClose={onClose}
      onEnter={handleCreate}
    >
      <div className={styles.missing} data-note-missing-sheet>
        {Boolean(sources.length) && (
          <div className={styles.hint}>
            {lang('KnowledgeMissingRefs', {
              count: sources.length, names: sources.map((source) => `«${source}»`).join(', '),
            }, { pluralValue: sources.length })}
          </div>
        )}
        <label className={styles.field}>
          {lang('KnowledgeMissingName')}
          <input
            className={kit.input}
            value={name}
            autoComplete="off"
            data-missing-name
            onChange={handleName}
            onKeyDown={handleKey}
          />
        </label>
        <div className={buildClassName(kit.grp, styles.folderRow)}>
          <button
            type="button"
            className={kit.row}
            data-missing-folder
            onClick={isPicking ? stopPicking : startPicking}
          >
            <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeMissingFolder')}</span>
            <span className={styles.folderValue}>
              {picked ? folderCaption(picked.path) : lang('KnowledgeRoot')}
            </span>
          </button>
        </div>
        {isPicking && (
          <div className={styles.folderList}>
            {renderFolderOption(undefined, lang('KnowledgeRoot'))}
            {folders.map((folder) => renderFolderOption(folder.id, folderCaption(folder.path)))}
          </div>
        )}
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          disabled={!name.trim()}
          data-missing-create
          onClick={handleCreate}
        >
          {lang('KnowledgeMissingCreate')}
        </button>
        <button type="button" className={kit.btn} data-missing-later onClick={onClose}>
          {lang('KnowledgeMissingLater')}
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(NoteMissingSheet);
