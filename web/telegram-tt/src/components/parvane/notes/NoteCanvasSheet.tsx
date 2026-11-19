import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { createEmptyCanvas, parseCanvas, serializeCanvas } from './notesCanvas';
import { addNoteToCanvas } from './notesCanvasAdd';
import { freeCanvasTitle } from './notesCanvasGraph';
import { getCanvases, getNotesVaultName, saveCanvas } from './notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  note?: NoteEntry;
  onOpenCanvas?: (canvasId: string) => void;
  onClose: NoneToVoidFunction;
};

// «Добавить на холст» из меню заметки (доски `XpNotes`, `ZdNotesX`): выбор холста либо новый холст; карточка
// заметки встаёт на него, холст открывается
const NoteCanvasSheet = ({ note, onOpenCanvas, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const canvases = useDerivedState(getCanvases);
  const [isBusy, markBusy, unmarkBusy] = useFlag();

  const handlePick = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!note || isBusy) return;
    const canvasId = e.currentTarget.dataset.canvasId;
    const canvas = canvasId ? canvases.find(({ id }) => id === canvasId) : undefined;
    const parsed = canvas ? parseCanvas(canvas.text) : undefined;
    // Повреждённый файл холста не переписывается
    if (parsed?.error) {
      showNotification({ message: lang('KnowledgeCanvasAddFailed') });
      return;
    }
    const title = canvas?.title || freeCanvasTitle(note.title, canvases.map((item) => item.title));
    const added = addNoteToCanvas(parsed?.doc || createEmptyCanvas(), note.title, note.id);
    markBusy();
    const id = await saveCanvas(title, serializeCanvas(added.doc), getNotesVaultName(), canvas?.id);
    unmarkBusy();
    if (!id) return;
    onClose();
    showNotification({ message: lang('KnowledgeCanvasAdded', { name: title }) });
    onOpenCanvas?.(id);
  });

  return (
    <PvSheet isOpen={Boolean(note)} title={lang('KnowledgeAddToCanvas')} isTight onClose={onClose}>
      <div className={styles.canvasList} data-note-canvas-sheet>
        {canvases.map((canvas) => (
          <button
            key={canvas.id}
            type="button"
            className={kit.row}
            disabled={isBusy}
            data-canvas-id={canvas.id}
            data-canvas-option={canvas.title}
            onClick={handlePick}
          >
            <PvIcon name="board" isSmall />
            <span className={buildClassName(kit.rowText, kit.ttl)}>{canvas.title}</span>
          </button>
        ))}
        <button type="button" className={kit.row} disabled={isBusy} data-canvas-option-new onClick={handlePick}>
          <PvIcon name="plus" isSmall />
          <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeCanvasNew')}</span>
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(NoteCanvasSheet);
