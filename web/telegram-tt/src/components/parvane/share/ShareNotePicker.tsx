import { memo, useEffect, useMemo, useState } from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import buildClassName from '../../../util/buildClassName';
import { folderCaption } from '../notes/notesFolders';
import { previewOf } from '../notes/notesLook';
import { noteSearchText } from '../notes/notesModel';
import {
  getNotes, getNotesStatus, loadNotes, retainNotes,
} from '../notes/notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvIcon from '../notes/PvIcon';
import PvLoading from '../notes/PvLoading';

import kit from '../notes/PvKit.module.scss';
import styles from './ShareSheet.module.scss';

type OwnProps = {
  isBusy?: boolean;
  onNew: NoneToVoidFunction;
  onPick: (noteId: string) => void;
};

// «Поделиться → В заметку» (доска `ZpSysGen`): новая заметка первой строкой, ниже — существующие с поиском
const ShareNotePicker = ({ isBusy, onNew, onPick }: OwnProps) => {
  const lang = useLang();
  const [query, setQuery] = useState('');
  const notes = useDerivedState(getNotes);
  const status = useDerivedState(getNotesStatus);

  // Пока выбор открыт, заметки следят за облаком
  useEffect(() => {
    const release = retainNotes();
    void loadNotes(getGlobal().currentUserId);
    return release;
  }, []);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!words.length) return sorted;
    return sorted.filter((note) => {
      const text = `${note.title.toLowerCase().replace(/ё/g, 'е')} ${noteSearchText(note)}`;
      return words.every((word) => text.includes(word));
    });
  }, [notes, query]);

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.noteId!);
  });

  const isLoading = status === 'loading' && !notes.length;

  return (
    <div className={styles.group} data-share-note-picker>
      <button type="button" className={kit.row} disabled={isBusy} data-share-note-new onClick={onNew}>
        <span className={buildClassName(kit.ava, kit.avaM)}>
          <PvIcon name="plus" isSmall />
        </span>
        <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeNewNote')}</span>
      </button>
      <input
        className={buildClassName(kit.input, styles.search)}
        type="search"
        value={query}
        placeholder={lang('ArticleSearch')}
        aria-label={lang('ArticleSearch')}
        data-share-note-search
        onChange={handleQuery}
      />
      {isLoading && <PvLoading />}
      {!isLoading && Boolean(notes.length) && !shown.length && <PvEmpty text={lang('KnowledgeNothingFound')} />}
      {shown.map((note) => (
        <button
          key={note.id}
          type="button"
          className={kit.row}
          disabled={isBusy}
          data-note-id={note.id}
          data-share-note={note.title}
          onClick={handlePick}
        >
          <span className={buildClassName(kit.ava, kit.avaM)}>
            <PvIcon name="note" isSmall />
          </span>
          <span className={kit.rowText}>
            <span className={kit.ttl}>{note.title}</span>
            <span className={kit.sub}>
              {[note.folder ? folderCaption(note.folder) : '', previewOf(note)].filter(Boolean).join(' · ')}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
};

export default memo(ShareNotePicker);
