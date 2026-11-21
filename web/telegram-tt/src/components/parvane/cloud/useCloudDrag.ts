import { useRef, useState } from '../../../lib/teact/teact';

import type { CloudDragEntry, CloudDropTarget } from './cloudDrop';
import type { CloudNode } from './cloudModel';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import { pickDragged, planCloudDrop } from './cloudDrop';
import { moveCloudNodes, moveCloudNodesAcross } from './cloudStore';

import useLastCallback from '../../../hooks/useLastCallback';

import dragStyles from './CloudDrag.module.scss';

type Options = {
  // Открытая папка принимает файлы с компьютера
  canUpload: boolean;
  selected: CloudDragEntry[];
  getEntry: (container: string, nodeId: string) => CloudDragEntry | undefined;
  canEdit: (container: string) => boolean;
  nodesOf: (container: string) => CloudNode[];
  onUpload: (files: File[]) => void;
};

// Строки тащат с этим типом: зона загрузки файлов его не принимает
const ROW_TYPE = 'application/x-parvane-cloud-rows';
// Размер браузер даёт только при отпускании: зона ещё столько стоит с ним (доска `ZdMisc`: «3 файла · 48 МБ»)
const DROPPED_SHOW_MS = 1500;

/**
 * Перетаскивание в «Файлах» (доски `ZdMisc`, `XdFiles`), все события — на корне раздела. Файлы с компьютера:
 * пока их тащат над окном — зона «Отпустите, чтобы загрузить…», отпущенные загружаются в открытую папку.
 * Строки (компьютер): выделенное либо одна строка переносится на папку списка, ступень пути или «Мой диск»
 * колонки мест; цель отмечена атрибутами `data-drop-container` / `data-drop-folder` / `data-drop-name`.
 */
export default function useCloudDrag({
  canUpload, selected, getEntry, canEdit, nodesOf, onUpload,
}: Options) {
  // Сколько файлов тащат над окном; `undefined` — не тащат
  const [uploadCount, setUploadCount] = useState<number>();
  // Только что отпущенные файлы: сколько и сколько весят
  const [dropped, setDropped] = useState<{ count: number; bytes: number }>();
  const droppedTimerRef = useRef<number>();
  // Тащат строки: название папки под курсором, если на неё можно отпустить
  // `isNav` — цель в колонке мест слева («Перетащите на папку слева — «…»», доска `XdFiles`)
  const [rowDrag, setRowDrag] = useState<{ target?: string; isNav?: boolean }>();
  const depthRef = useRef(0);
  const draggedRef = useRef<CloudDragEntry[]>();
  const overRef = useRef<HTMLElement>();

  const markOver = (element?: HTMLElement) => {
    const previous = overRef.current;
    if (previous === element) return;
    overRef.current = element;
    requestMutation(() => {
      previous?.classList.remove(dragStyles.dropOver);
      element?.classList.add(dragStyles.dropOver);
    });
  };

  const finishRowDrag = () => {
    draggedRef.current = undefined;
    markOver(undefined);
    setRowDrag(undefined);
  };

  /** Цель под курсором и что будет при отпускании. */
  const findDrop = (e: React.DragEvent) => {
    const dragged = draggedRef.current;
    const element = (e.target as HTMLElement).closest<HTMLElement>('[data-drop-container]');
    if (!dragged || !element) return undefined;
    const target: CloudDropTarget = {
      container: element.dataset.dropContainer!, folder: element.dataset.dropFolder || undefined,
    };
    if (!canEdit(target.container)) return undefined;
    const plan = planCloudDrop(dragged, target, nodesOf);
    return plan ? {
      element, plan, name: element.dataset.dropName || element.dataset.name,
      isNav: Boolean(element.closest('[data-cloud-nav]')),
    } : undefined;
  };

  const onDragStart = useLastCallback((e: React.DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id][draggable="true"]');
    const entry = row && getEntry(row.dataset.container!, row.dataset.nodeId!);
    if (!entry || !e.dataTransfer) return;
    const dragged = pickDragged(entry, selected);
    draggedRef.current = dragged;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(ROW_TYPE, dragged.map((d) => d.node.id).join(','));
    setRowDrag({});
  });

  const onDragEnd = useLastCallback(finishRowDrag);

  const onDragEnter = useLastCallback((e: React.DragEvent) => {
    if (draggedRef.current || !canUpload || !hasFiles(e)) return;
    e.preventDefault();
    depthRef.current += 1;
    const items = Array.from(e.dataTransfer?.items || []).filter((item) => item.kind === 'file');
    setUploadCount(items.length);
  });

  const onDragOver = useLastCallback((e: React.DragEvent) => {
    if (!draggedRef.current) {
      if (canUpload && hasFiles(e)) e.preventDefault();
      return;
    }
    const drop = findDrop(e);
    markOver(drop?.element);
    if (rowDrag?.target !== drop?.name || rowDrag?.isNav !== drop?.isNav) {
      setRowDrag({ target: drop?.name, isNav: drop?.isNav });
    }
    if (!drop) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });

  const onDragLeave = useLastCallback(() => {
    if (draggedRef.current) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (!depthRef.current) setUploadCount(undefined);
  });

  const onDrop = useLastCallback((e: React.DragEvent) => {
    if (draggedRef.current) {
      const drop = findDrop(e);
      finishRowDrag();
      if (!drop) return;
      e.preventDefault();
      const { plan } = drop;
      if (plan.kind === 'same') void moveCloudNodes(plan.container, plan.nodes, plan.folder);
      else void moveCloudNodesAcross(plan.from, plan.nodes, plan.to, plan.folder);
      return;
    }
    depthRef.current = 0;
    setUploadCount(undefined);
    if (!canUpload || !hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    setDropped({ count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) });
    window.clearTimeout(droppedTimerRef.current);
    droppedTimerRef.current = window.setTimeout(() => setDropped(undefined), DROPPED_SHOW_MS);
    onUpload(files);
  });

  return {
    uploadCount,
    dropped,
    rowDrag,
    handlers: {
      onDragStart, onDragEnd, onDragEnter, onDragOver, onDragLeave, onDrop,
    },
  };
}

function hasFiles(e: React.DragEvent) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}
