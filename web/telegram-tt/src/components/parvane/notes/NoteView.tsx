import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MdEmbed } from '../markdown/markdown';
import type { PlannerState } from '../planner/plannerModel';
import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { openPlannerDay, requestPlannerAddInPlace } from '../../../util/parvaneSection';
import { getCloudData, getNodes, uploadCloudFilesTo } from '../cloud/cloudStore';
import { parseMarkdown } from '../markdown/markdown';
import { formatRepeat } from '../planner/plannerFormat';
import { toDayKey } from '../planner/plannerModel';
import { resolveDrivePath } from './notesCanvasFiles';
import { nextNoteTitle, NOTE_TITLE_MAX } from './notesCanvasNote';
import { resolveEmbed } from './notesEmbeds';
import { folderCaption } from './notesFolders';
import { displayTitle, formatDayShort, isDayTitle } from './notesLook';
import { parseNote, setTaskDone } from './notesModel';
import { nearestPlanned, notePlanLine } from './notesPlanned';
import { getNoteTasks, markerOfTask } from './notesTasks';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import MarkdownBlocks from '../markdown/MarkdownBlocks';
import CanvasFilePicker from './CanvasFilePicker';
import NoteEmbed from './NoteEmbed';
import NoteLinks from './NoteLinks';
import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

// Просьба открыть правку заметки с выделенным куском текста (ссылка, которую с графа убрать нельзя)
export type NoteEditRequest = { noteId: string; from: number; to: number; at: number };

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planner: PlannerState;
  planned: PlannedItem[];
  // Узкий экран: заметка занимает весь раздел, сверху своя шапка и стрелка назад
  onBack?: NoneToVoidFunction;
  // «Связи» стоят под заметкой, когда для них нет отдельного острова справа
  hasLinks?: boolean;
  // «Связи» без малого графа: заметка стоит в панели большого
  isGraphHidden?: boolean;
  editRequest?: NoteEditRequest;
  onOpenTitle: (title: string) => void;
  // `base` — текст, с которого начата правка: изменения заметки, пришедшие за время правки, сводятся с ней
  onSave: (noteId: string, text: string, base?: string) => Promise<boolean>;
  onRename: (noteId: string, title: string) => void;
  onDelete: (noteId: string) => void;
  // Перенос в другую папку: открыть выбор папки
  onPickFolder?: (noteId: string) => void;
};

const MARKER = / \^(t[a-z0-9]{4,12})\s*$/;
// Сколько прошедших записей остаётся в «Запланировано» перед будущими
const PLANNED_PAST_MAX = 3;
// Высота строки редактора, если её не удалось узнать у браузера
const EDITOR_LINE_HEIGHT = 22;

// Заметка: чтение с живыми ссылками, тегами и круглыми галочками; правка — текстом `.md`.
// Ниже — «Запланировано» (записи «Плана» со ссылкой сюда), на узком экране ещё и «Связи»
const NoteView = ({
  note, index, planner, planned, onBack, hasLinks, isGraphHidden, editRequest, onOpenTitle, onSave, onRename,
  onDelete, onPickFolder,
}: OwnProps) => {
  const [draft, setDraft] = useState<string>();
  const baseRef = useRef<string>();
  const editorRef = useRef<HTMLTextAreaElement>();
  const handledRequestRef = useRef<number>();
  const selectionRef = useRef<{ from: number; to: number }>();
  const [title, setTitle] = useState(note.title);
  const [isSaving, markSaving, unmarkSaving] = useFlag();
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();
  const [isCloudPickerOpen, openCloudPicker, closeCloudPicker] = useFlag();
  const fileInputRef = useRef<HTMLInputElement>();
  const { showNotification } = getActions();

  const lang = useLang();

  useEffect(() => {
    setDraft(undefined);
    setTitle(note.title);
  }, [note.id, note.title]);

  // Просьба о правке выполняется один раз: открывает редактор и запоминает, что выделить
  useEffect(() => {
    if (!editRequest || editRequest.noteId !== note.id || handledRequestRef.current === editRequest.at) return;
    handledRequestRef.current = editRequest.at;
    selectionRef.current = { from: editRequest.from, to: editRequest.to };
    baseRef.current = note.text;
    setDraft(note.text);
  }, [editRequest, note.id, note.text]);

  // Редактор открылся по просьбе: кусок выделен и виден
  useEffect(() => {
    const selection = selectionRef.current;
    const editor = editorRef.current;
    if (!selection || !editor || draft === undefined) return;
    selectionRef.current = undefined;
    editor.focus();
    editor.setSelectionRange(selection.from, selection.to);
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || EDITOR_LINE_HEIGHT;
    const line = editor.value.slice(0, selection.from).split('\n').length - 1;
    editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 2);
  }, [draft]);

  const isEditing = draft !== undefined;
  const isDaily = note.isDaily && isDayTitle(note.title);
  const parsed = useMemo(() => parseNote(note.text), [note.text]);
  const blocks = useMemo(() => parseMarkdown(note.text, note.title), [note.text, note.title]);
  // Встроенные файлы ищутся на личном диске
  const cloud = useDerivedState(getCloudData);
  const driveId = cloud?.rootId;
  const driveNodes = useMemo(() => (driveId ? getNodes(driveId, cloud) : []), [cloud, driveId]);
  const [today] = useState(() => toDayKey(new Date()));

  // Пункты, ставшие задачами «Плана»: метка пункта → задача
  const taskByMarker = useMemo(() => (
    new Map(getNoteTasks(planner, note.id).map((task) => [markerOfTask(task), task]))
  ), [planner, note.id]);

  const shownPlanned = useMemo(() => {
    const past = planned.filter((item) => item.day && item.day < today);
    return [...past.slice(-PLANNED_PAST_MAX), ...planned.filter((item) => !item.day || item.day >= today)];
  }, [planned, today]);
  const nearest = nearestPlanned(planned, today);

  const handleEdit = useLastCallback(() => {
    baseRef.current = note.text;
    setDraft(note.text);
  });

  const handleCancel = useLastCallback(() => {
    setDraft(undefined);
  });

  const handleDraft = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.currentTarget.value);
  });

  const handleSave = useLastCallback(async () => {
    if (draft === undefined) return;
    markSaving();
    const isSaved = await onSave(note.id, draft, baseRef.current);
    unmarkSaving();
    if (isSaved) setDraft(undefined);
  });

  const handleTitle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.currentTarget.value);
  });

  // Значение берётся из самого поля: уход фокуса может прийти раньше перерисовки с набранным текстом
  const handleTitleBlur = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const next = nextNoteTitle(e.currentTarget.value, note.title);
    if (next) onRename(note.id, next);
    else setTitle(note.title);
  });

  const handleTitleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  });

  const handleLink = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenTitle(e.currentTarget.dataset.title!);
  });

  const handleDelete = useLastCallback(() => {
    closeDelete();
    onDelete(note.id);
  });

  // «Запланировать»: окно ввода текстом «Плана» со ссылкой на заметку — запись с ней встаёт в «Запланировано»
  const handlePlan = useLastCallback(() => {
    requestPlannerAddInPlace(notePlanLine(note.title));
  });

  // Заметка дня: её день в «Плане» на экране «Сегодня» (название заметки — ключ дня)
  const handleOpenDay = useLastCallback(() => {
    openPlannerDay(note.title);
  });

  const handleFolder = useLastCallback(() => {
    onPickFolder?.(note.id);
  });

  const formatWhen = (day?: string, time?: string, due?: string) => {
    if (day) return `${formatDayShort(lang, day)}${time ? ` ${time}` : ''}`;
    return due ? lang('PlannerDueValue', { date: formatDayShort(lang, due) }) : '';
  };

  const handleToggleTask = useLastCallback((line: number, isDone: boolean) => {
    void onSave(note.id, setTaskDone(note.text, line, isDone));
  });

  const renderNoteLink = useLastCallback((part: { text: string; target: string }, key: string) => {
    const isMissing = !index.byTitle(part.target);
    return (
      <button
        key={key}
        type="button"
        className={buildClassName(styles.link, isMissing && styles.linkMissing)}
        data-title={part.target}
        title={isMissing ? lang('KnowledgeMissingNote') : undefined}
        onClick={handleLink}
      >
        {part.text}
      </button>
    );
  });

  // Пункт, ставший задачей «Плана»: служебная метка не показывается, вместо неё — дата задачи
  const taskTail = useLastCallback((text: string) => {
    const planTask = taskByMarker.get(MARKER.exec(text)?.[1] || '');
    const when = planTask && formatWhen(planTask.day, planTask.start, planTask.due);
    return {
      text: text.replace(MARKER, ''),
      tail: when ? (
        <span className={styles.dateTag}>
          <PvIcon name="cal" className={styles.dateTagIcon} />
          {when}
        </span>
      ) : undefined,
    };
  });

  const renderEmbed = useLastCallback((embed: MdEmbed) => (
    <NoteEmbed embed={embed} noteId={note.id} driveId={driveId} nodes={driveNodes} />
  ));

  // Встроить файлы: строки `![[имя]]` встают на место курсора (отдельными строками)
  const insertEmbeds = useLastCallback((names: string[]) => {
    if (!names.length) return;
    const editor = editorRef.current;
    setDraft((prev) => {
      if (prev === undefined) return prev;
      const at = editor ? Math.min(editor.selectionStart, prev.length) : prev.length;
      const before = prev.slice(0, at);
      const after = prev.slice(at);
      const lead = before && !before.endsWith('\n') ? '\n' : '';
      const tail = after.startsWith('\n') ? '' : '\n';
      return `${before}${lead}${names.map((name) => `![[${name}]]`).join('\n')}${tail}${after}`;
    });
  });

  // Новые файлы — в облако рядом с заметкой, в текст — их имена
  const uploadAndInsert = useLastCallback(async (files: File[]) => {
    if (!files.length) return;
    if (!driveId) {
      showNotification({ message: lang('KnowledgeInsertFailed') });
      return;
    }
    const parent = driveNodes.find((node) => node.id === note.id)?.parent || undefined;
    const names = await uploadCloudFilesTo(driveId, parent, files);
    const uploaded = names.filter((name): name is string => Boolean(name));
    insertEmbeds(uploaded);
    if (uploaded.length < files.length) showNotification({ message: lang('KnowledgeInsertFailed') });
  });

  const handlePickedFiles = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files || []);
    e.currentTarget.value = '';
    void uploadAndInsert(files);
  });

  const handleChooseFiles = useLastCallback(() => {
    fileInputRef.current?.click();
  });

  // Файл из облака: имя, если по нему находится именно этот файл, иначе путь от корня диска
  const handlePickCloud = useLastCallback((path: string) => {
    closeCloudPicker();
    const node = resolveDrivePath(driveNodes, path);
    if (!node) return;
    insertEmbeds([resolveEmbed(driveNodes, node.name, note.id)?.id === node.id ? node.name : path]);
  });

  const handleEditorDragOver = useLastCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });

  const handleEditorDrop = useLastCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    void uploadAndInsert(files);
  });

  const handleEditorPaste = useLastCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    void uploadAndInsert(files);
  });

  const properties = Object.entries(parsed.properties);
  const folderName = isDaily ? lang('KnowledgeDailyFolder')
    : note.folder ? folderCaption(note.folder) : lang('KnowledgeRoot');

  return (
    <article className={styles.note} data-note-id={note.id} data-note-title={note.title}>
      {onBack && (
        <header className={buildClassName(kit.hdr, styles.noteBar)}>
          <h1 className={buildClassName(kit.hdrSmall, kit.muted, kit.grow)}>{folderName}</h1>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang(isEditing ? 'KnowledgeSave' : 'KnowledgeEdit')}
            disabled={isSaving}
            onClick={isEditing ? handleSave : handleEdit}
          >
            <PvIcon name={isEditing ? 'check' : 'edit'} />
          </button>
        </header>
      )}
      <div className={styles.noteBody}>
        {onBack && (
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnGhost, styles.backButton)}
            aria-label={lang('KnowledgeBack')}
            onClick={onBack}
          >
            <PvIcon name="left" isSmall />
            {lang('ParvaneSectionKnowledge')}
          </button>
        )}
        {isDaily ? (
          <h2 className={styles.noteTitle}>{displayTitle(lang, note)}</h2>
        ) : (
          <input
            className={buildClassName(styles.noteTitle, styles.noteTitleInput, isEditing && styles.noteTitleEditing)}
            value={title}
            maxLength={NOTE_TITLE_MAX}
            aria-label={lang('KnowledgeNoteTitle')}
            onChange={handleTitle}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKey}
          />
        )}
        <div className={styles.props}>
          {onPickFolder && !isDaily ? (
            <button
              type="button"
              className={buildClassName(kit.plain, styles.prop, styles.propButton)}
              aria-label={`${folderName}. ${lang('KnowledgeMoveNote')}`}
              title={lang('KnowledgeMoveNote')}
              data-note-folder={note.folder}
              onClick={handleFolder}
            >
              <PvIcon name="folder" isSmall />
              {folderName}
            </button>
          ) : <span className={styles.prop}>{folderName}</span>}
          {properties.map(([key, value]) => (
            <span key={key} className={styles.prop}>
              {`${key} `}
              <b>{Array.isArray(value) ? value.join(', ') : value}</b>
            </span>
          ))}
          {nearest && (
            <span className={styles.prop}>
              {`${lang('KnowledgeNearest')} `}
              <b>{`${formatDayShort(lang, nearest.day!)}${nearest.time ? `, ${nearest.time}` : ''}`}</b>
            </span>
          )}
        </div>
        {isEditing ? (
          <>
            <div className={styles.editorTools} data-note-insert>
              <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={handleChooseFiles}>
                <PvIcon name="upload" isSmall />
                {lang('KnowledgeInsertFile')}
              </button>
              <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={openCloudPicker}>
                <PvIcon name="cloud" isSmall />
                {lang('KnowledgeInsertFromCloud')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className={styles.hiddenInput}
                data-note-insert-input
                onChange={handlePickedFiles}
              />
            </div>
            <textarea
              ref={editorRef}
              id="knowledge-note-editor"
              className={buildClassName(kit.textarea, styles.editor)}
              value={draft}
              placeholder={lang('KnowledgeEditorPlaceholder')}
              aria-label={note.title}
              onChange={handleDraft}
              onDragOver={handleEditorDragOver}
              onDrop={handleEditorDrop}
              onPaste={handleEditorPaste}
            />
          </>
        ) : (
          <div className={styles.md} data-note-body>
            <MarkdownBlocks
              blocks={blocks}
              renderNote={renderNoteLink}
              renderEmbed={renderEmbed}
              onToggleTask={handleToggleTask}
              taskTail={taskTail}
            />
          </div>
        )}
        <div className={styles.noteButtons}>
          {isEditing ? (
            <>
              <button type="button" className={kit.btn} disabled={isSaving} onClick={handleSave}>
                <PvIcon name="check" isSmall />
                {lang('KnowledgeSave')}
              </button>
              <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={handleCancel}>
                {lang('Cancel')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className={kit.btn} onClick={handleEdit}>
                <PvIcon name="edit" isSmall />
                {lang('KnowledgeEdit')}
              </button>
              {isDaily ? (
                <button type="button" className={kit.btn} data-note-open-day onClick={handleOpenDay}>
                  <PvIcon name="cal" isSmall />
                  {lang('KnowledgeOpenDay')}
                </button>
              ) : (
                <button type="button" className={kit.btn} data-note-plan onClick={handlePlan}>
                  <PvIcon name="cal" isSmall />
                  {lang('KnowledgePlan')}
                </button>
              )}
              <button
                type="button"
                className={buildClassName(kit.btn, kit.btnGhost)}
                onClick={openDelete}
              >
                <PvIcon name="trash" isSmall />
                {lang('KnowledgeDelete')}
              </button>
            </>
          )}
        </div>
        {!isDaily && Boolean(shownPlanned.length) && (
          <section className={buildClassName(kit.card, styles.planned)} data-note-planned>
            <div className={kit.cardHead}>
              <h3 className={buildClassName(kit.cardTitle, kit.grow)}>{lang('KnowledgePlanned')}</h3>
              <span className={styles.plannedHint}>{lang('KnowledgePlannedHint')}</span>
            </div>
            {shownPlanned.map((item) => (
              <div
                key={item.key}
                className={buildClassName(
                  styles.plannedRow, item.day && item.day < today && !item.repeat && styles.plannedPast,
                )}
                style={`--c: var(--pv-${item.kind})`}
                data-planned-kind={item.kind}
              >
                <span className={styles.plannedDay}>
                  {item.day ? formatDayShort(lang, item.day) : lang('KnowledgeNoDate')}
                </span>
                <span className={styles.plannedBar} />
                <span className={buildClassName(kit.rowText, kit.ttl)}>
                  {item.name}
                  {item.repeat && <span className={styles.plannedNote}>{` · ${formatRepeat(lang, item.repeat)}`}</span>}
                  {item.isActive && !item.day && (
                    <span className={styles.plannedNote}>{` · ${lang('PlannerStatusActive')}`}</span>
                  )}
                </span>
                <span className={kit.meta}>
                  {item.day ? item.time || '' : item.due
                    ? lang('PlannerDueValue', { date: formatDayShort(lang, item.due) }) : ''}
                </span>
              </div>
            ))}
          </section>
        )}
        {hasLinks && (
          <NoteLinks
            className={styles.linksInline}
            note={note}
            index={index}
            planned={planned}
            isGraphHidden={isGraphHidden}
            onOpenTitle={onOpenTitle}
          />
        )}
      </div>
      <CanvasFilePicker
        isOpen={isCloudPickerOpen}
        nodes={driveNodes}
        onPick={handlePickCloud}
        onClose={closeCloudPicker}
      />
      <ConfirmDialog
        isOpen={isDeleteOpen}
        text={lang('KnowledgeDeleteConfirm', { name: note.title })}
        confirmLabel={lang('KnowledgeDelete')}
        confirmIsDestructive
        confirmHandler={handleDelete}
        onClose={closeDelete}
      />
    </article>
  );
};

export default memo(NoteView);
