import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import type { NoteEntry } from '../notes/notesStore';

import { SEARCH_FIELD_PROPS } from '../../../util/searchField';
import { folderCaption } from '../notes/notesFolders';
import { previewOf } from '../notes/notesLook';
import { noteSearchText } from '../notes/notesModel';
import {
  getNotes, getNotesStatus, loadNotes, retainNotes,
} from '../notes/notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Loading from '../../ui/Loading';
import SearchForm from '../../ui/SearchForm';
import PvSheet from '../notes/PvSheet';

import styles from './Article.module.scss';

type OwnProps = {
  isOpen: boolean;
  title: string;
  hint?: string;
  // Строка «Новая заметка» над списком; нет — выбор только из готовых
  newLabel?: string;
  onNew?: () => Promise<void> | void;
  // Выбранная заметка; пока обещание не выполнено, список не нажимается
  onPick: (note: NoteEntry) => Promise<void> | void;
  onClose: NoneToVoidFunction;
};

// Выбор заметки (доска `RpPick`): поиск по названию и тексту, список с папкой и началом текста. Им пользуются
// «Статья» в меню вложений и «В заметку» в меню сообщения
const NotePickerModal = ({
  isOpen, title, hint, newLabel, onNew, onPick, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const notes = useDerivedState(getNotes);
  const status = useDerivedState(getNotesStatus);

  // Пока окно открыто, заметки следят за облаком; хранилище само не создаётся
  useEffect(() => {
    if (!isOpen) return undefined;
    const release = retainNotes();
    void loadNotes(getGlobal().currentUserId);
    return () => {
      release();
      setQuery('');
    };
  }, [isOpen]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    const sorted = [...notes].sort((a, b) => a.title.localeCompare(b.title));
    if (!words.length) return sorted;
    return sorted.filter((note) => {
      const text = `${note.title.toLowerCase().replace(/ё/g, 'е')} ${noteSearchText(note)}`;
      return words.every((word) => text.includes(word));
    });
  }, [notes, query]);

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const runBusy = useLastCallback(async (id: string, run: () => Promise<void> | void) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await run();
    } finally {
      setBusyId(undefined);
    }
  });

  const isLoading = status === 'loading' && !notes.length;

  return (
    <PvSheet isOpen={isOpen} title={title} className={styles.picker} onClose={onClose}>
      {hint && <p className={styles.pickerHint}>{hint}</p>}
      <SearchForm>
        <input
          {...SEARCH_FIELD_PROPS}
          className={styles.pickerSearch}
          value={query}
          placeholder={lang('ArticleSearch')}
          aria-label={lang('ArticleSearch')}
          data-article-search
          onChange={handleQuery}
        />
      </SearchForm>
      <div className={styles.pickerList} data-article-notes>
        {newLabel && onNew && (
          <button
            type="button"
            className={styles.pickerRow}
            disabled={Boolean(busyId)}
            data-note-pick-new
            onClick={() => runBusy('', onNew)}
          >
            <span className={styles.pickerTitle}>{newLabel}</span>
          </button>
        )}
        {isLoading && <Loading />}
        {!isLoading && !notes.length && <p className={styles.pickerEmpty}>{lang('ArticleNoNotes')}</p>}
        {!isLoading && Boolean(notes.length) && !shown.length && (
          <p className={styles.pickerEmpty}>{lang('KnowledgeNothingFound')}</p>
        )}
        {shown.map((note) => (
          <button
            key={note.id}
            type="button"
            className={styles.pickerRow}
            disabled={Boolean(busyId)}
            data-article-note={note.title}
            onClick={() => runBusy(note.id, () => onPick(note))}
          >
            <span className={styles.pickerTitle}>{note.title}</span>
            <span className={styles.pickerMeta}>
              {note.folder ? `${folderCaption(note.folder)} · ` : ''}
              {previewOf(note)}
            </span>
          </button>
        ))}
      </div>
    </PvSheet>
  );
};

export default memo(NotePickerModal);
