import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLang from '../../../hooks/useLang';

import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

export type FolderRemoval = { id: string; name: string; count: number };

type OwnProps = {
  // Папка с заметками, которую удаляют; без неё шторка закрыта
  removal?: FolderRemoval;
  onMove: NoneToVoidFunction;
  onDeleteAll: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

// Удаление папки с заметками (доска `ZpNotesX`): заметки в «Без папки» либо в корзину вместе с папкой
const NoteFolderRemoval = ({
  removal, onMove, onDeleteAll, onClose,
}: OwnProps) => {
  const lang = useLang();

  const shown = useCurrentOrPrev(removal, true);

  return (
    <PvSheet
      isOpen={Boolean(removal)}
      title={lang('KnowledgeFolderDeleteQuestion', { name: shown?.name || '' })}
      onClose={onClose}
    >
      <div className={styles.folderForm} data-folder-removal>
        <p className={styles.folderFormText}>
          {lang('KnowledgeFolderDeleteConfirm', { count: shown?.count || 0 })}
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
      </div>
    </PvSheet>
  );
};

export default memo(NoteFolderRemoval);
