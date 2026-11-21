import { memo } from '../../../lib/teact/teact';

import type { FolderSubmitError, NoteFolder } from './notesFolders';

import buildClassName from '../../../util/buildClassName';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLang from '../../../hooks/useLang';

import NoteFolderActions from './NoteFolderActions';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

// `refs` — сколько заметок вне папки ссылаются на её заметки
export type FolderRemoval = {
  id: string; name: string; count: number; refs: number;
};

type OwnProps = {
  // Папка с заметками, которую удаляют; без неё шторка закрыта
  removal?: FolderRemoval;
  // Сама папка — для «Других действий с папкой»
  folder?: NoteFolder;
  onMove: NoneToVoidFunction;
  onDeleteAll: NoneToVoidFunction;
  onRename: (name: string) => Promise<FolderSubmitError | undefined>;
  onClose: NoneToVoidFunction;
};

// Удаление папки с заметками (доска `ZpNotesX`): заметки в «Без папки» либо в корзину вместе с папкой; ниже —
// другие действия с той же папкой
const NoteFolderRemoval = ({
  removal, folder, onMove, onDeleteAll, onRename, onClose,
}: OwnProps) => {
  const lang = useLang();

  const shown = useCurrentOrPrev(removal, true);
  const count = shown?.count || 0;
  const refs = shown?.refs || 0;

  return (
    <PvSheet
      isOpen={Boolean(removal)}
      title={lang('KnowledgeFolderDeleteQuestion', { name: shown?.name || '' })}
      onClose={onClose}
    >
      <div className={styles.folderForm} data-folder-removal>
        <p className={styles.folderFormText} data-folder-removal-text>
          {lang('KnowledgeFolderDeleteNotes', { count }, { pluralValue: count })}
          {' '}
          {refs ? lang('KnowledgeFolderDeleteRefs', { count: refs }, { pluralValue: refs })
            : lang('KnowledgeFolderDeleteNoRefs')}
        </p>
        <button
          type="button"
          id="knowledge-folder-delete-move"
          className={buildClassName(kit.btn, kit.btnAcc)}
          onClick={onMove}
        >
          {lang('KnowledgeFolderDeleteAction')}
        </button>
        <button
          type="button"
          id="knowledge-folder-delete-all"
          className={buildClassName(kit.btn, kit.btnDanger)}
          onClick={onDeleteAll}
        >
          {lang('KnowledgeFolderDeleteWithNotes')}
        </button>
        <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>
        {folder && (
          <>
            <p className={kit.grp}>{lang('KnowledgeFolderOtherActions')}</p>
            <NoteFolderActions folder={folder} onRename={onRename} onDone={onClose} />
          </>
        )}
      </div>
    </PvSheet>
  );
};

export default memo(NoteFolderRemoval);
