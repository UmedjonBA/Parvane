import { memo, useMemo, useRef } from '../../../lib/teact/teact';

import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { folderCaption, ROOT_FOLDER } from './notesFolders';
import { listNoteLinks } from './notesLinksView';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './GraphPanelLinks.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planned: PlannedItem[];
  onOpenInNotes: NoneToVoidFunction;
  // Нажатие на связь выбирает заметку на графе
  onPickTitle: (title: string) => void;
  // Ссылка из этой заметки на заметку с названием (новую либо существующую)
  onLink: (fromId: string, title: string) => void;
  onUnlink: (fromId: string, toTitle: string) => void;
};

const TITLE_MAX = 120;

// Панель выбранной заметки графа по макету (доска `XdNotes`): «Открыть в заметках», связи карточкой — у
// ссылки отдельной строкой «Убрать связь», у ссылки внутри текста пометка «из текста», — и поле «Связать с
// заметкой». Текст самой заметки стоит ниже (чтение и правка на месте — сверх макета)
const GraphPanelLinks = ({
  note, index, planned, onOpenInNotes, onPickTitle, onLink, onUnlink,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();

  const lang = useLang();

  const items = useMemo(() => (
    listNoteLinks(note.id, index, planned).filter(({ way }) => way !== 'record')
  ), [note.id, index, planned]);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickTitle(e.currentTarget.dataset.title!);
  });

  const handleUnlink = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onUnlink(note.id, e.currentTarget.dataset.unlink!);
  });

  const handleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const title = e.currentTarget.value.trim();
    if (e.key !== 'Enter' || !title) return;
    onLink(note.id, title);
    inputRef.current!.value = '';
  });

  const folder = note.folder === ROOT_FOLDER ? lang('KnowledgeRoot') : folderCaption(note.folder);
  const hasInline = items.some(({ way, isRemovable }) => way !== 'in' && !isRemovable);

  return (
    <div className={styles.root} data-graph-panel-links={items.length}>
      <div className={styles.sub}>
        {`${folder} · ${lang('KnowledgeLinksCount', { count: items.length }, { pluralValue: items.length })}`}
      </div>
      <button
        type="button"
        className={buildClassName(kit.btn, kit.btnAcc, styles.open)}
        data-graph-panel-open
        onClick={onOpenInNotes}
      >
        <PvIcon name="open" isSmall />
        {lang('KnowledgeGraphOpenInNotes')}
      </button>
      <div className={kit.caps}>{lang('KnowledgeLinksTitle', { count: items.length })}</div>
      {items.length > 0 && (
        <div className={buildClassName(kit.card, styles.card)} data-note-backlinks>
          {items.map((item) => (
            <div key={item.key} className={styles.row} data-link-way={item.way}>
              <button type="button" className={styles.rowTitle} data-title={item.title} onClick={handlePick}>
                {item.title}
              </button>
              {item.way !== 'in' && item.isRemovable ? (
                <button
                  type="button"
                  className={styles.rowRemove}
                  data-unlink={item.title}
                  data-graph-panel-unlink={item.title}
                  onClick={handleUnlink}
                >
                  {lang('KnowledgeGraphRemoveLink')}
                </button>
              ) : (
                <span className={styles.rowNote}>
                  {lang(item.way === 'in' ? 'KnowledgeLinkWayIn' : 'KnowledgeGraphLinkInText')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {!note.isDaily && (
        <label className={styles.field}>
          {lang('KnowledgeGraphLinkWith')}
          <input
            ref={inputRef}
            className={buildClassName(kit.input, styles.input)}
            type="text"
            maxLength={TITLE_MAX}
            placeholder={lang('KnowledgeGraphLinkWithHint')}
            autoComplete="off"
            data-graph-panel-link-input
            onKeyDown={handleKey}
          />
        </label>
      )}
      {hasInline && <div className={styles.hint}>{lang('KnowledgeGraphLinkInTextHint')}</div>}
    </div>
  );
};

export default memo(GraphPanelLinks);
