import { memo, useState } from '../../../lib/teact/teact';

import type { NoteGroup } from './notesFolders';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { folderCaption, ROOT_FOLDER } from './notesFolders';
import { folderColor } from './notesLook';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './NotesColumn.module.scss';
import kit from './PvKit.module.scss';

// Место модуля на компьютере: заметки (папка либо все), холсты, справка по разметке, корзина
export type NotesPlace = 'notes' | 'canvas' | 'help' | 'trash';

export const NOTE_DRAG_TYPE = 'application/x-parvane-note';

type OwnProps = {
  groups: NoteGroup<NoteEntry>[];
  total: number;
  canvasCount: number;
  place: NotesPlace;
  // Выбранная папка (ключ группы); без неё — «Все заметки»
  openGroupKey?: string;
  onOpenGroup: (key?: string) => void;
  onPlace: (place: NotesPlace) => void;
  onNewFolder: NoneToVoidFunction;
  onFolderMenu: (folderId: string) => void;
  onMoveNote: (noteId: string, folderId?: string) => void;
};

// Колонка «Заметок» на компьютере (доска `ZdNotesX`, выбрана вместо плоского списка `DeskNotes` как более
// поздняя): «Папки» — все заметки и папки со счётчиком, «Ещё» — холсты, справка по разметке, корзина
const NotesColumn = ({
  groups, total, canvasCount, place, openGroupKey, onOpenGroup, onPlace, onNewFolder, onFolderMenu, onMoveNote,
}: OwnProps) => {
  const lang = useLang();
  // Папка под указателем при перетаскивании заметки
  const [dropKey, setDropKey] = useState<string>();

  const captionOf = (group: NoteGroup<NoteEntry>) => (
    group.isDaily ? lang('KnowledgeDailyFolder')
      : group.folder === ROOT_FOLDER ? lang('KnowledgeRoot') : folderCaption(group.folder)
  );
  const isTarget = (group: NoteGroup<NoteEntry>) => (
    !group.isDaily && (group.folder === ROOT_FOLDER || Boolean(group.folderId))
  );

  const colorOf = (group: NoteGroup<NoteEntry>) => (
    group.folder === ROOT_FOLDER ? 'var(--pv-muted)' : folderColor(group.folder, group.isDaily)
  );

  const handleAll = useLastCallback(() => onOpenGroup(undefined));
  const handleGroup = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenGroup(e.currentTarget.dataset.groupKey);
  });
  // Правая кнопка по папке — её действия (шторка папки)
  const handleGroupMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { folderId } = e.currentTarget.dataset;
    if (!folderId) return;
    e.preventDefault();
    onFolderMenu(folderId);
  });
  const handlePlace = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPlace(e.currentTarget.dataset.place as NotesPlace);
  });

  const handleDragOver = useLastCallback((e: React.DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes(NOTE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const key = e.currentTarget.dataset.groupKey;
    if (key !== dropKey) setDropKey(key);
  });
  const handleDragLeave = useLastCallback((e: React.DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey(undefined);
  });
  const handleDrop = useLastCallback((e: React.DragEvent<HTMLElement>) => {
    const noteId = e.dataTransfer.getData(NOTE_DRAG_TYPE);
    setDropKey(undefined);
    if (!noteId) return;
    e.preventDefault();
    onMoveNote(noteId, e.currentTarget.dataset.folderId || undefined);
  });

  const isNotes = place === 'notes';

  function renderPlace(value: NotesPlace, icon: 'board' | 'text' | 'trash', label: string, count?: number) {
    return (
      <button
        type="button"
        className={buildClassName(styles.row, place === value && styles.rowOn)}
        aria-current={place === value || undefined}
        data-place={value}
        data-notes-place={value}
        onClick={handlePlace}
      >
        <PvIcon name={icon} className={styles.icon} />
        <span className={styles.name}>{label}</span>
        {count !== undefined && <span className={styles.count}>{count}</span>}
      </button>
    );
  }

  return (
    <nav
      className={buildClassName(styles.root, 'custom-scroll')}
      aria-label={lang('KnowledgeFolders')}
      data-notes-column
    >
      <div className={styles.cap}>
        <h2 className={styles.capTitle}>{lang('KnowledgeFolders')}</h2>
        <button
          type="button"
          className={buildClassName(kit.ib, styles.capButton)}
          aria-label={lang('KnowledgeNewFolder')}
          title={lang('KnowledgeNewFolder')}
          data-notes-new-folder
          onClick={onNewFolder}
        >
          <PvIcon name="plus" isSmall />
        </button>
      </div>
      <button
        type="button"
        className={buildClassName(styles.row, isNotes && openGroupKey === undefined && styles.rowOn)}
        aria-current={(isNotes && openGroupKey === undefined) || undefined}
        data-notes-all
        onClick={handleAll}
      >
        <PvIcon name="note" className={styles.icon} />
        <span className={styles.name}>{lang('KnowledgeAllNotes')}</span>
        <span className={styles.count} data-folder-count>{total}</span>
      </button>
      <div data-notes-folders>
        {groups.map((group) => {
          const canDrop = isTarget(group);
          return (
            <button
              key={group.key}
              type="button"
              className={buildClassName(
                styles.row,
                isNotes && openGroupKey === group.key && styles.rowOn,
                dropKey === group.key && styles.rowDrop,
              )}
              style={`--c: ${colorOf(group)}`}
              aria-current={(isNotes && openGroupKey === group.key) || undefined}
              data-folder={group.folder}
              data-folder-id={group.folderId}
              data-group-key={group.key}
              onClick={handleGroup}
              onContextMenu={handleGroupMenu}
              onDragOver={canDrop ? handleDragOver : undefined}
              onDragLeave={canDrop ? handleDragLeave : undefined}
              onDrop={canDrop ? handleDrop : undefined}
            >
              <PvIcon name="folder" className={buildClassName(styles.icon, styles.folderIcon)} />
              <span className={styles.name}>{captionOf(group)}</span>
              <span className={styles.count} data-folder-count>{group.items.length}</span>
            </button>
          );
        })}
      </div>
      <h2 className={buildClassName(styles.cap, styles.capTitle)}>{lang('KnowledgeMore')}</h2>
      {renderPlace('canvas', 'board', lang('KnowledgeCanvases'), canvasCount)}
      {renderPlace('help', 'text', lang('KnowledgeMdHelp'))}
      {renderPlace('trash', 'trash', lang('KnowledgeTrash'))}
    </nav>
  );
};

export default memo(NotesColumn);
