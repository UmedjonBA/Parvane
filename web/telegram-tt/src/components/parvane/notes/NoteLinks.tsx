import { memo, useMemo } from '../../../lib/teact/teact';

import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { listNoteLinks } from './notesLinksView';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import NoteLinksGraph from './NoteLinksGraph';

import styles from './NoteLinks.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planned: PlannedItem[];
  className?: string;
  // Только карточки: рядом уже стоит большой граф
  isGraphHidden?: boolean;
  onOpenTitle: (title: string) => void;
};

const WAY_KEYS = {
  in: 'KnowledgeLinkWayIn',
  out: 'KnowledgeLinkWayOut',
  both: 'KnowledgeLinkWayBoth',
} as const;

// «Связи» заметки по макету (доски `DeskNotes`, `PhNotesMore`): малый граф и карточки — на кого заметка
// ссылается, кто ссылается на неё, записи «Плана» со ссылкой сюда
const NoteLinks = ({
  note, index, planned, className, isGraphHidden, onOpenTitle,
}: OwnProps) => {
  const lang = useLang();

  const items = useMemo(() => listNoteLinks(note.id, index, planned), [note.id, index, planned]);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenTitle(e.currentTarget.dataset.title!);
  });

  return (
    <div className={buildClassName(styles.root, className)} data-note-links={items.length}>
      <h3 className={kit.caps}>{lang('KnowledgeLinksTitle', { count: items.length })}</h3>
      {!isGraphHidden && items.length > 0 && (
        <NoteLinksGraph note={note} index={index} planned={planned} onOpenTitle={onOpenTitle} />
      )}
      {!items.length && <p className={styles.empty}>{lang('KnowledgeBacklinksEmpty')}</p>}
      <div className={styles.cards} data-note-backlinks>
        {items.map((item) => (item.way === 'record' ? (
          <div key={item.key} className={buildClassName(kit.card, styles.card)} data-link-way="record">
            <span className={styles.cardTitle}>{item.title}</span>
            <span className={styles.cardSub}>
              {lang(item.recordKind === 'task' ? 'KnowledgeGraphKindTask' : 'KnowledgeGraphKindEvent')}
            </span>
          </div>
        ) : (
          <button
            key={item.key}
            type="button"
            className={buildClassName(kit.card, styles.card, styles.cardButton)}
            data-title={item.title}
            data-link-way={item.way}
            onClick={handleOpen}
          >
            <span className={styles.cardTitle}>{item.title}</span>
            <span className={styles.cardSub}>{lang(WAY_KEYS[item.way])}</span>
          </button>
        )))}
      </div>
    </div>
  );
};

export default memo(NoteLinks);
