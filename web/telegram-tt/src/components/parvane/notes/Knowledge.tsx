import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { consumeNoteRequest, getKnowledgeView, getNoteRequest } from '../../../util/parvaneSection';
import { getPlannerState, loadPlanner } from '../planner/plannerStore';
import {
  applyPlannerToNotes, createNote, deleteNote, findNoteByTitle, getCanvases, getNotes, getNotesIndex,
  getNotesNotice, getNotesStatus, loadNotes, renameNote, saveNote,
} from './notesStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import Button from '../../ui/Button';
import Loading from '../../ui/Loading';
import KnowledgeTabs from './KnowledgeTabs';
import NotesCanvas from './NotesCanvas';
import NotesGraph from './NotesGraph';
import NoteView from './NoteView';

import styles from './Knowledge.module.scss';

const NARROW_WIDTH = 925;
const NOTICE_HIDE_MS = 6000;
const NOTICE_KEYS = {
  conflict: 'KnowledgeNoticeConflict',
  merged: 'KnowledgeNoticeMerged',
  failed: 'KnowledgeNoticeFailed',
} as const;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Parvane: раздел «Знания» — заметки `.md` в зашифрованной папке облака, граф связей и холсты.
// Вкладка «Файлы» — прежнее «Облако» (его рисует `Cloud`, шапка у них общая — `KnowledgeTabs`)
const Knowledge = () => {
  const notes = useDerivedState(getNotes);
  const canvases = useDerivedState(getCanvases);
  const status = useDerivedState(getNotesStatus);
  const notice = useDerivedState(getNotesNotice);
  const view = useDerivedState(getKnowledgeView);
  const planner = useDerivedState(getPlannerState);
  const noteRequest = useDerivedState(getNoteRequest);
  const currentUserId = useSelector(selectCurrentUserId);

  const [openId, setOpenId] = useState<string>();
  const [query, setQuery] = useState('');
  const [isNoticeShown, setIsNoticeShown] = useState(false);

  const lang = useLang();
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;
  const vaultName = lang('KnowledgeVaultName');

  useEffect(() => {
    void loadNotes(currentUserId);
    void loadPlanner(currentUserId);
  }, [currentUserId]);

  // Галочки и удаления из «Плана» доезжают до пунктов заметок
  useEffect(() => {
    if (status === 'ready') void applyPlannerToNotes(vaultName);
  }, [planner, status, vaultName]);

  useEffect(() => {
    if (!notice) return undefined;
    setIsNoticeShown(true);
    const timer = window.setTimeout(() => setIsNoticeShown(false), NOTICE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const index = useMemo(() => getNotesIndex(notes), [notes]);
  const openNote = notes.find(({ id }) => id === openId);

  // Ссылка на заметку, которой ещё нет, создаёт её
  const openTitle = useLastCallback(async (title: string) => {
    const existing = findNoteByTitle(title);
    const id = existing?.id || await createNote(title, vaultName);
    if (id) setOpenId(id);
  });

  useEffect(() => {
    if (!noteRequest || status !== 'ready') return;
    consumeNoteRequest();
    void openTitle(noteRequest);
  }, [noteRequest, status]);

  const handleNew = useLastCallback(async () => {
    const id = await createNote(lang('KnowledgeNewNote'), vaultName);
    if (id) setOpenId(id);
  });

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setOpenId(e.currentTarget.dataset.id);
  });

  const handleBack = useLastCallback(() => {
    setOpenId(undefined);
  });

  const handleSave = useLastCallback((noteId: string, text: string) => saveNote(noteId, text, vaultName));

  const handleRename = useLastCallback((noteId: string, title: string) => {
    void renameNote(noteId, title, vaultName);
  });

  const handleDelete = useLastCallback((noteId: string) => {
    setOpenId(undefined);
    void deleteNote(noteId);
  });

  const handleOpenFromGraph = useLastCallback((noteId: string) => {
    setOpenId(noteId);
  });

  const found = useMemo(() => (query.trim() ? index.search(query) : undefined), [index, query]);
  const groups = useMemo(() => {
    const source: NoteEntry[] = found ? found.map((item) => notes.find(({ id }) => id === item.id)!) : notes;
    const byFolder = new Map<string, NoteEntry[]>();
    source.filter(Boolean).forEach((note) => {
      byFolder.set(note.folder, [...(byFolder.get(note.folder) || []), note]);
    });
    return [...byFolder.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [notes, found]);

  const isList = view === 'notes';
  const isNoteShown = isList && Boolean(openNote);

  return (
    <div id="ParvaneKnowledge" className={styles.root} data-knowledge-view={view} data-status={status}>
      <header className={styles.header}>
        {!isNarrow && <h1 className={styles.title}>{lang('ParvaneSectionKnowledge')}</h1>}
        <KnowledgeTabs className={styles.tabs} />
        {isList && (
          <div className={styles.headerButtons}>
            <Button size="smaller" onClick={handleNew}>{lang('KnowledgeNewNote')}</Button>
          </div>
        )}
      </header>
      {isNoticeShown && notice && (
        <div className={styles.notice} role="status">{lang(NOTICE_KEYS[notice.code], { name: notice.title })}</div>
      )}
      <div className={buildClassName(styles.content, 'custom-scroll')}>
        {status !== 'ready' ? <Loading /> : view === 'graph' ? (
          <NotesGraph notes={notes} planner={planner} onOpenNote={handleOpenFromGraph} onOpenTitle={openTitle} />
        ) : view === 'canvas' ? (
          <NotesCanvas canvases={canvases} notes={notes} isNarrow={isNarrow} onOpenTitle={openTitle} />
        ) : (
          <div className={buildClassName(styles.layout, isNoteShown && styles.layoutNote)}>
            <aside className={styles.list} data-notes-list>
              <input
                id="knowledge-search"
                className={buildClassName('form-control', styles.search)}
                type="search"
                value={query}
                placeholder={lang('KnowledgeSearch')}
                aria-label={lang('KnowledgeSearch')}
                onChange={handleQuery}
              />
              {!notes.length && <p className={styles.muted}>{lang('KnowledgeEmpty')}</p>}
              {Boolean(notes.length) && !groups.length && (
                <p className={styles.muted}>{lang('KnowledgeNothingFound')}</p>
              )}
              {groups.map(([folder, items]) => (
                <section key={folder} className={styles.group} data-folder={folder}>
                  <h3 className={styles.groupTitle}>{folder || lang('KnowledgeRoot')}</h3>
                  {items.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      className={buildClassName(styles.row, note.id === openId && styles.rowActive)}
                      data-id={note.id}
                      data-note-row={note.title}
                      onClick={handlePick}
                    >
                      <span className={styles.rowTitle}>{note.title}</span>
                      <span className={styles.rowPreview}>{index.byId(note.id)?.parsed.preview}</span>
                    </button>
                  ))}
                </section>
              ))}
            </aside>
            <div className={styles.pane}>
              {openNote ? (
                <NoteView
                  note={openNote}
                  index={index}
                  planner={planner}
                  onBack={isNarrow ? handleBack : undefined}
                  onOpenTitle={openTitle}
                  onSave={handleSave}
                  onRename={handleRename}
                  onDelete={handleDelete}
                />
              ) : <p className={styles.muted}>{lang('KnowledgePickNote')}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(Knowledge);
