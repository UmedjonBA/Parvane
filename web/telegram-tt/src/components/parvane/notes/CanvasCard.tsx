import { memo, useMemo } from '../../../lib/teact/teact';

import type { CloudNode } from '../cloud/cloudModel';
import type { CanvasNode, CanvasSide } from './notesCanvas';
import type { CanvasHandle } from './notesCanvasEdit';
import type { CanvasImageQuality } from './notesCanvasImages';
import type { CanvasInlineKind, NoteCardState } from './notesCanvasNote';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { CANVAS_SIDES } from './notesCanvas';
import { CANVAS_CORNER_HANDLES, CANVAS_HANDLES } from './notesCanvasEdit';
import { colorStyle, renderCardInline } from './notesCanvasLook';
import { NOTE_TITLE_MAX, notePreviewLines } from './notesCanvasNote';
import { folderColor } from './notesLook';
import { parseNote, parseNoteCached } from './notesModel';

import useLang from '../../../hooks/useLang';

import CanvasFileBody from './CanvasFileBody';
import CanvasLinkBody from './CanvasLinkBody';
import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type InlineField = HTMLTextAreaElement | HTMLInputElement;

// Правка на месте — только у той карточки, которую правят; у остальных `undefined`
export type CanvasCardInline = { kind: CanvasInlineKind; text: string };

type OwnProps = {
  node: CanvasNode;
  isSelected: boolean;
  // Режим связи: карточка — возможная цель стрелки
  isLinkable: boolean;
  // Группа под указателем: её возьмёт перетаскивание
  isHover: boolean;
  // Ручки размера и показанные точки для стрелок — у единственного выделенного узла
  hasGrips: boolean;
  // Точки для стрелок есть (хоть и скрыты): нет ни режима связи, ни правки этой карточки
  arePortsShown: boolean;
  inline?: CanvasCardInline;
  // Карточка файла — заметка: её название, сама заметка (нет — удалена либо ещё читается) и состояние
  noteTitle?: string;
  note?: NoteEntry;
  noteState?: NoteCardState;
  // Текст заметки, отправленный на запись: карточка показывает его, не дожидаясь ответа облака
  savingText?: string;
  // Карточка файла облака
  driveId?: string;
  driveNode?: CloudNode;
  imageQuality: CanvasImageQuality;
  // Карточка на экране достаточно крупна для картинки в полном качестве
  isLargeImage: boolean;
  onInlineChange: (e: React.ChangeEvent<InlineField>) => void;
  onInlineBlur: NoneToVoidFunction;
  onInlineKey: (e: React.KeyboardEvent<InlineField>) => void;
  onOpenNote: (e: React.MouseEvent<HTMLButtonElement>) => void;
};

const NOTE_EDIT_MAX_HEIGHT = 360;
const PREVIEW_LINES = 7;
// Пустая строка текста держит свою высоту неразрывным пробелом; копия текста в поле правки кончается
// пробелом нулевой ширины, чтобы последняя пустая строка тоже занимала место
const EMPTY_LINE = String.fromCharCode(0xa0);
const MIRROR_TAIL = String.fromCharCode(0x200b);

const HANDLE_CLASSES: Record<CanvasHandle, string> = {
  n: styles.canvasHandleN,
  ne: styles.canvasHandleNe,
  e: styles.canvasHandleE,
  se: styles.canvasHandleSe,
  s: styles.canvasHandleS,
  sw: styles.canvasHandleSw,
  w: styles.canvasHandleW,
  nw: styles.canvasHandleNw,
};
const PORT_CLASSES: Record<CanvasSide, string> = {
  top: styles.canvasPortTop,
  right: styles.canvasPortRight,
  bottom: styles.canvasPortBottom,
  left: styles.canvasPortLeft,
};

// Сколько раз отрисовалась каждая карточка — для теста: во время жеста несдвинутые карточки не перерисовываются
const rendersById = new Map<string, number>();

export function getCanvasCardRenders(id: string) {
  return rendersById.get(id) || 0;
}

// Карточка или группа холста. Перерисовывается только при смене своих данных: сдвиг и масштаб поля, движение
// других карточек, ход правки в другой карточке её не трогают (все обработчики — постоянные)
const CanvasCard = ({
  node, isSelected, isLinkable, isHover, hasGrips, arePortsShown, inline, noteTitle, note, noteState, savingText,
  driveId, driveNode, imageQuality, isLargeImage, onInlineChange, onInlineBlur, onInlineKey, onOpenNote,
}: OwnProps) => {
  const lang = useLang();
  rendersById.set(node.id, getCanvasCardRenders(node.id) + 1);

  // Начало текста заметки без разметки; считается по заметке, не на каждую отрисовку
  const lines = useMemo(() => {
    if (!note) return undefined;
    const body = savingText === undefined ? parseNoteCached(note).body : parseNote(savingText).body;
    return notePreviewLines(body, note.title, PREVIEW_LINES);
  }, [note, savingText]);

  const place = `left: ${node.x}px; top: ${node.y}px; width: ${node.width}px`;
  const handles = hasGrips && (node.type === 'group' ? CANVAS_CORNER_HANDLES : CANVAS_HANDLES).map((handle) => (
    <i
      key={handle}
      className={buildClassName(styles.canvasHandle, HANDLE_CLASSES[handle])}
      title={lang('KnowledgeCanvasResize')}
      data-canvas-handle={handle}
    />
  ));
  const ports = arePortsShown && CANVAS_SIDES.map((side) => (
    <i
      key={side}
      className={buildClassName(styles.canvasPort, PORT_CLASSES[side], hasGrips && styles.canvasPortShown)}
      title={lang('KnowledgeCanvasPort')}
      data-canvas-port={side}
    />
  ));

  if (node.type === 'group') {
    return (
      <div
        data-canvas-node={node.id}
        data-canvas-type={node.type}
        className={buildClassName(
          styles.canvasGroup, isSelected && styles.canvasSelected, isHover && styles.canvasGroupHover,
        )}
        style={`${colorStyle(node.color)}${place}; height: ${node.height}px`}
      >
        <i className={buildClassName(styles.canvasGroupEdge, styles.canvasGroupEdgeTop)} />
        <i className={buildClassName(styles.canvasGroupEdge, styles.canvasGroupEdgeRight)} />
        <i className={buildClassName(styles.canvasGroupEdge, styles.canvasGroupEdgeBottom)} />
        <i className={buildClassName(styles.canvasGroupEdge, styles.canvasGroupEdgeLeft)} />
        {/* Шапка вдоль верхнего края: за неё группу берут, по двойному нажатию называют */}
        <div className={styles.canvasGroupHead} data-canvas-group-head>
          {inline ? (
            <input
              className={styles.canvasGroupInput}
              value={inline.text}
              placeholder={lang('KnowledgeCanvasGroupName')}
              aria-label={lang('KnowledgeCanvasGroupName')}
              data-canvas-inline
              onChange={onInlineChange}
              onBlur={onInlineBlur}
              onKeyDown={onInlineKey}
            />
          ) : node.label ? (
            <span className={styles.canvasGroupLabel} data-canvas-group-label>{node.label}</span>
          ) : (
            <span
              className={buildClassName(styles.canvasGroupLabel, styles.canvasGroupGrip)}
              title={lang('KnowledgeCanvasUnnamedGroup')}
              data-canvas-group-grip
            >
              <PvIcon name="group" isSmall />
              {lang('KnowledgeCanvasGroup')}
            </span>
          )}
        </div>
        {handles}
      </div>
    );
  }
  const cardClass = buildClassName(
    styles.canvasCard, isSelected && styles.canvasSelected, isLinkable && styles.canvasLinkable,
  );
  if (node.type === 'link') {
    return (
      <div
        data-canvas-node={node.id}
        data-canvas-type={node.type}
        className={buildClassName(cardClass, styles.canvasCardText)}
        style={`${colorStyle(node.color)}${place}; height: ${node.height}px`}
      >
        <CanvasLinkBody url={node.url || ''} />
        {ports}
        {handles}
      </div>
    );
  }
  if (node.type !== 'file') {
    // Высота текстовой карточки — не меньше заданной и не меньше её текста
    const isAuto = node.type === 'text';
    return (
      <div
        data-canvas-node={node.id}
        data-canvas-type={node.type}
        className={buildClassName(cardClass, styles.canvasCardText)}
        style={`${colorStyle(node.color)}${place}; ${isAuto ? 'min-height' : 'height'}: ${node.height}px`}
      >
        {inline ? (
          <div className={styles.canvasInlineBox}>
            {/* Невидимая копия текста задаёт высоту поля: карточка растёт вместе с набранным */}
            <div className={styles.canvasInlineMirror} aria-hidden="true">{`${inline.text}${MIRROR_TAIL}`}</div>
            <textarea
              className={styles.canvasInline}
              value={inline.text}
              placeholder={lang('KnowledgeCanvasText')}
              aria-label={lang('KnowledgeCanvasText')}
              data-canvas-inline
              onChange={onInlineChange}
              onBlur={onInlineBlur}
              onKeyDown={onInlineKey}
            />
          </div>
        ) : (
          <div className={buildClassName(styles.canvasCardBody, styles.canvasCardBodyText)} data-canvas-body>
            {(node.text || '').split('\n').map((line, i) => (
              <div key={i}>{line ? renderCardInline(line) : EMPTY_LINE}</div>
            ))}
          </div>
        )}
        {ports}
        {handles}
      </div>
    );
  }
  if (noteTitle === undefined) {
    return (
      <div
        data-canvas-node={node.id}
        data-canvas-type={node.type}
        className={cardClass}
        style={`${colorStyle(node.color)}${place}; height: ${node.height}px`}
      >
        <CanvasFileBody
          path={node.file || ''}
          container={driveId}
          node={driveNode}
          quality={imageQuality}
          isLarge={isLargeImage}
        />
        {ports}
        {handles}
      </div>
    );
  }
  const isEditingText = inline?.kind === 'note';
  const isEditingTitle = inline?.kind === 'title';
  const inlineText = inline?.text || '';
  return (
    <div
      data-canvas-node={node.id}
      data-canvas-type={node.type}
      data-canvas-note={noteState}
      className={buildClassName(cardClass, isEditingText && styles.canvasCardEditing)}
      // Пока правится текст, карточка растёт за ним; размер узла в файле от этого не меняется
      style={`--gc: ${note ? folderColor(note.folder, note.isDaily) : 'var(--pv-faint)'}; ${place}; ${
        isEditingText ? 'min-height' : 'height'}: ${node.height}px`}
    >
      <div className={styles.canvasCardHead} data-canvas-note-head>
        <i className={styles.canvasCardDot} />
        {isEditingTitle ? (
          <input
            className={styles.canvasTitleInput}
            value={inlineText}
            maxLength={NOTE_TITLE_MAX}
            aria-label={lang('KnowledgeNoteTitle')}
            data-canvas-inline
            data-canvas-note-title-input
            onChange={onInlineChange}
            onBlur={onInlineBlur}
            onKeyDown={onInlineKey}
          />
        ) : (
          <span className={buildClassName(kit.ttl, styles.canvasCardTitle)} data-canvas-note-title={noteTitle}>
            {noteTitle}
          </span>
        )}
        {note && !isEditingTitle && (
          <button
            type="button"
            className={styles.canvasCardOpen}
            title={lang('KnowledgeCanvasOpenNote')}
            aria-label={lang('KnowledgeCanvasOpenNote')}
            data-node={node.id}
            data-canvas-open-note
            onClick={onOpenNote}
          >
            <PvIcon name="open" isSmall />
          </button>
        )}
      </div>
      {isEditingText ? (
        <div
          className={styles.canvasNoteBox}
          style={`max-height: ${Math.max(NOTE_EDIT_MAX_HEIGHT, node.height)}px`}
        >
          {/* Невидимая копия текста задаёт высоту поля; выше предела поле листается */}
          <div className={styles.canvasInlineMirror} aria-hidden="true">{`${inlineText}${MIRROR_TAIL}`}</div>
          <textarea
            className={buildClassName(styles.canvasInline, styles.canvasNoteEditor)}
            value={inlineText}
            placeholder={lang('KnowledgeEditorPlaceholder')}
            aria-label={lang('KnowledgeCanvasNoteText')}
            title={lang('KnowledgeCanvasNoteSaveHint')}
            data-canvas-inline
            data-canvas-note-editor
            onChange={onInlineChange}
            onBlur={onInlineBlur}
            onKeyDown={onInlineKey}
          />
        </div>
      ) : (
        <div className={styles.canvasCardBody} data-canvas-note-body>
          {lines ? lines.map((line, i) => (
            <div key={i}>{renderCardInline(line)}</div>
          )) : (
            <div className={kit.faint}>
              {lang(noteState === 'loading' ? 'KnowledgeCanvasNoteLoading' : 'KnowledgeCanvasNoteMissing')}
            </div>
          )}
        </div>
      )}
      {ports}
      {handles}
    </div>
  );
};

export default memo(CanvasCard);
