import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { consumeNoteRequest, getKnowledgeView, getNoteRequest } from '../../../util/parvaneSection';
import { toDayKey } from '../planner/plannerModel';
import { getPlannerState, loadPlanner } from '../planner/plannerStore';
import {
  avatarText, displayTitle, folderColor, formatDayShort, isDayTitle, previewOf,
} from './notesLook';
import { buildPlannedIndex, nearestPlanned, plannedOf } from './notesPlanned';
import {
  applyPlannerToNotes, createNote, deleteNote, findNoteByTitle, getCanvases, getNotes, getNotesIndex,
  getNotesNotice, getNotesStatus, loadNotes, openDailyNote, renameNote, saveNote,
} from './notesStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import Loading from '../../ui/Loading';
import KnowledgeTabs from './KnowledgeTabs';
import NoteLinks from './NoteLinks';
import NotesCanvas from './NotesCanvas';
import NotesGraph from './NotesGraph';
import NoteView from './NoteView';
import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

// Узкий экран: виден либо список, либо заметка; вкладки раздела — подчёркнутой строкой
const NARROW_WIDTH = 760;
// Широкий экран: «Связи» открытой заметки — отдельный остров справа
const SIDE_MIN_WIDTH = 1241;
const NOTICE_HIDE_MS = 6000;
// Столько последних заметок дня видно в списке, пока не попросили все
const DAILY_SHOWN = 5;
const NOTE_LINK = /(\[\[[^\]\n]+\]\])/;
const NOTICE_KEYS = {
  conflict: 'KnowledgeNoticeConflict',
  merged: 'KnowledgeNoticeMerged',
  failed: 'KnowledgeNoticeFailed',
} as const;

type Group = { folder: string; isDaily: boolean; items: NoteEntry[]; hidden: number };

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
  const [areAllDailyShown, setAreAllDailyShown] = useState(false);

  const lang = useLang();
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;
  const hasSide = windowWidth >= SIDE_MIN_WIDTH;
  const vaultName = lang('KnowledgeVaultName');
  const [today] = useState(() => toDayKey(new Date()));

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
  const plannedIndex = useMemo(() => buildPlannedIndex(planner, today), [planner, today]);
  const openNote = notes.find(({ id }) => id === openId);
  const openPlanned = useMemo(() => (
    openNote ? plannedOf(plannedIndex, openNote) : []
  ), [plannedIndex, openNote]);

  // Ссылка на заметку, которой ещё нет, создаёт её
  const openTitle = useLastCallback(async (title: string) => {
    const existing = findNoteByTitle(title);
    // Название-дата — заметка дня: создаётся по шаблону в своей папке
    const id = existing?.id || (isDayTitle(title)
      ? await openDailyNote(title, vaultName, lang('KnowledgeDailyFolder'))
      : await createNote(title, vaultName));
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

  const handleShowAllDaily = useLastCallback(() => {
    setAreAllDailyShown(true);
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
  // Папки по алфавиту, заметки дня — отдельной группой в конце, свежие сверху
  const groups = useMemo(() => {
    const source: NoteEntry[] = found ? found.map((item) => notes.find(({ id }) => id === item.id)!) : notes;
    const byFolder = new Map<string, NoteEntry[]>();
    const daily: NoteEntry[] = [];
    source.filter(Boolean).forEach((note) => {
      if (note.isDaily && isDayTitle(note.title)) daily.push(note);
      else byFolder.set(note.folder, [...(byFolder.get(note.folder) || []), note]);
    });
    const result: Group[] = [...byFolder.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([folder, items]) => ({
        folder, isDaily: false, items, hidden: 0,
      }));
    if (daily.length) {
      daily.sort((a, b) => (a.title < b.title ? 1 : -1));
      const shown = found || areAllDailyShown ? daily : daily.slice(0, DAILY_SHOWN);
      result.push({
        folder: daily[0].folder, isDaily: true, items: shown, hidden: daily.length - shown.length,
      });
    }
    return result;
  }, [notes, found, areAllDailyShown]);

  const isList = view === 'notes';
  const isNoteShown = isList && Boolean(openNote);
  const isNoteAlone = isNarrow && isNoteShown;
  const openFolder = openNote && (openNote.isDaily ? lang('KnowledgeDailyFolder') : openNote.folder);

  function renderRow(note: NoteEntry) {
    const next = nearestPlanned(plannedOf(plannedIndex, note), today);
    return (
      <button
        key={note.id}
        type="button"
        className={buildClassName(kit.row, styles.listRow, note.id === openId && kit.rowSel)}
        data-id={note.id}
        data-note-row={note.title}
        onClick={handlePick}
      >
        <span className={kit.ava} style={`--c: ${folderColor(note.folder, note.isDaily)}`} aria-hidden="true">
          {avatarText(note)}
        </span>
        <span className={kit.rowText}>
          <span className={kit.ttl}>{displayTitle(lang, note)}</span>
          <span className={kit.sub}>{previewOf(note) || lang('KnowledgeNoteEmpty')}</span>
        </span>
        {next?.day && (
          <span className={kit.meta} title={lang('KnowledgeNearest')}>{formatDayShort(lang, next.day)}</span>
        )}
      </button>
    );
  }

  function renderList() {
    return (
      <aside className={buildClassName(styles.list, 'custom-scroll')} data-notes-list>
        <label className={buildClassName(kit.search, styles.listSearch)}>
          <PvIcon name="search" isSmall className={kit.searchIcon} />
          <input
            id="knowledge-search"
            className={kit.searchInput}
            type="search"
            value={query}
            placeholder={lang('KnowledgeSearch')}
            aria-label={lang('KnowledgeSearch')}
            autoComplete="off"
            onChange={handleQuery}
          />
        </label>
        {!notes.length && <p className={styles.mutedLine}>{lang('KnowledgeEmpty')}</p>}
        {Boolean(notes.length) && !groups.length && (
          <p className={styles.mutedLine}>{lang('KnowledgeNothingFound')}</p>
        )}
        {groups.map((group) => (
          <section key={group.isDaily ? '\u0000daily' : group.folder} data-folder={group.folder}>
            <h3 className={kit.grp}>
              {group.isDaily ? lang('KnowledgeDailyFolder') : group.folder || lang('KnowledgeRoot')}
            </h3>
            {group.items.map(renderRow)}
            {group.hidden > 0 && (
              <button
                type="button"
                className={buildClassName(kit.btn, kit.btnGhost, kit.btnWide)}
                onClick={handleShowAllDaily}
              >
                {lang('KnowledgeShowAll', { count: group.hidden + group.items.length })}
              </button>
            )}
          </section>
        ))}
        <button type="button" className={buildClassName(kit.btn, kit.btnWide, styles.newNote)} onClick={handleNew}>
          <PvIcon name="plus" isSmall />
          {lang('KnowledgeNewNote')}
        </button>
      </aside>
    );
  }

  return (
    <div id="ParvaneKnowledge" className={styles.root} data-knowledge-view={view} data-status={status}>
      <div className={buildClassName(kit.island, styles.page)}>
        {!isNoteAlone && (
          <header className={buildClassName(kit.hdr, kit.hdrTabs)}>
            <h1 className={buildClassName(kit.hdrTitle, kit.hideM)}>{lang('ParvaneSectionKnowledge')}</h1>
            <KnowledgeTabs />
            {isNoteShown && (
              <span className={buildClassName(kit.muted, kit.hideM, styles.crumb)}>
                {`/ ${openFolder || lang('KnowledgeRoot')}`}
              </span>
            )}
            <span className={buildClassName(kit.grow, kit.hideM)} />
            {isList && (
              <button
                type="button"
                className={buildClassName(kit.pill, kit.pillAcc, kit.hideM)}
                onClick={handleNew}
              >
                <PvIcon name="plus" isSmall />
                {lang('KnowledgeNoteShort')}
              </button>
            )}
            {view === 'canvas' && (
              <span className={buildClassName(kit.muted, kit.small, kit.hideM)}>{lang('KnowledgeCanvasHint')}</span>
            )}
          </header>
        )}
        {isNoticeShown && notice && (
          <div className={styles.notice} role="status">{lang(NOTICE_KEYS[notice.code], { name: notice.title })}</div>
        )}
        <div className={styles.content}>
          {status !== 'ready' ? <Loading /> : view === 'graph' ? (
            <NotesGraph notes={notes} planner={planner} onOpenNote={handleOpenFromGraph} onOpenTitle={openTitle} />
          ) : view === 'canvas' ? (
            <NotesCanvas canvases={canvases} notes={notes} isNarrow={isNarrow} onOpenTitle={openTitle} />
          ) : (
            <div className={styles.layout}>
              {!isNoteAlone && renderList()}
              {(!isNarrow || isNoteShown) && (
                <div className={buildClassName(styles.pane, 'custom-scroll')}>
                  {openNote ? (
                    <NoteView
                      note={openNote}
                      index={index}
                      planner={planner}
                      planned={openPlanned}
                      hasLinks={!hasSide}
                      onBack={isNarrow ? handleBack : undefined}
                      onOpenTitle={openTitle}
                      onSave={handleSave}
                      onRename={handleRename}
                      onDelete={handleDelete}
                    />
                  ) : (
                    <p className={styles.pickNote}>
                      {lang('KnowledgePickNote').split(NOTE_LINK).map((part, i) => (
                        part.startsWith('[[')
                          ? <span key={i} className={styles.linkSample}>{part}</span>
                          : part
                      ))}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {hasSide && isNoteShown && openNote && (
        <aside className={buildClassName(kit.island, styles.side)} aria-label={lang('KnowledgeLinks')}>
          <header className={kit.hdr}>
            <h1 className={kit.hdrSmall}>{lang('KnowledgeLinks')}</h1>
          </header>
          <div className={buildClassName(styles.sideContent, 'custom-scroll')}>
            <NoteLinks note={openNote} index={index} planned={openPlanned} onOpenTitle={openTitle} />
          </div>
        </aside>
      )}
    </div>
  );
};

export default memo(Knowledge);
