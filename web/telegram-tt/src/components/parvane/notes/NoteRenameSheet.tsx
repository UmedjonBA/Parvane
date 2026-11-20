import {
  memo, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { nextNoteTitle, NOTE_TITLE_MAX } from './notesCanvasNote';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  // Заметка, которую переименовывают; нет — шторка закрыта
  note?: NoteEntry;
  onRename: (noteId: string, title: string) => void;
  onClose: NoneToVoidFunction;
};

// «Переименовать» из меню строки списка заметок (доска `ZdNotesX`): название правится в шторке, заметка не
// открывается
const NoteRenameSheet = ({ note, onRename, onClose }: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();
  const [title, setTitle] = useState('');

  const lang = useLang();

  // Поле готовится в кадре появления шторки: иначе ввод сразу после открытия затирался прежним названием
  useLayoutEffect(() => {
    if (!note) return;
    setTitle(note.title);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [note]);

  const handleTitle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.currentTarget.value);
  });

  // Название берётся из самого поля: Enter приходит раньше перерисовки с набранным
  const handleSubmit = useLastCallback(() => {
    if (!note) return;
    const next = nextNoteTitle(inputRef.current?.value ?? title, note.title);
    onClose();
    if (next) onRename(note.id, next);
  });

  const handleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    handleSubmit();
  });

  return (
    <PvSheet isOpen={Boolean(note)} title={lang('KnowledgeFolderRename')} onClose={onClose}>
      <div className={styles.folderForm} data-note-rename>
        <input
          ref={inputRef}
          className={kit.input}
          value={title}
          maxLength={NOTE_TITLE_MAX}
          placeholder={lang('KnowledgeNoteTitle')}
          aria-label={lang('KnowledgeNoteTitle')}
          autoComplete="off"
          onChange={handleTitle}
          onKeyDown={handleKey}
        />
        <div className={kit.sheetButtons}>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            data-note-rename-submit
            onClick={handleSubmit}
          >
            <PvIcon name="edit" isSmall />
            {lang('KnowledgeFolderRename')}
          </button>
        </div>
      </div>
    </PvSheet>
  );
};

export default memo(NoteRenameSheet);
