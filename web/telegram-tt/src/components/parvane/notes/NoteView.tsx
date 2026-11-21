import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MdEmbed } from '../markdown/markdown';
import type { PlannerState } from '../planner/plannerModel';
import type { NoteMenuItem } from './NoteMenu';
import type { EditorState, EditorTool } from './notesEditorInsert';
import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';
import type { PvSegmentItem } from './PvSegment';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { getIsParvaneScreenShown, openPlannerDay, requestPlannerAddInPlace } from '../../../util/parvaneSection';
import { getCloudData, getNodes, uploadCloudFilesTo } from '../cloud/cloudStore';
import { parseMarkdown } from '../markdown/markdown';
import { formatRepeat } from '../planner/plannerFormat';
import { toDayKey } from '../planner/plannerModel';
import { resolveDrivePath } from './notesCanvasFiles';
import { nextNoteTitle, NOTE_TITLE_MAX } from './notesCanvasNote';
import { applyEditorTool, completeOpenLink, findOpenLink } from './notesEditorInsert';
import { replaceEmbedTarget, resolveEmbed } from './notesEmbeds';
import { folderCaption } from './notesFolders';
import { countNoteLinks, formatNoteEdited } from './notesList';
import { displayTitle, formatDayShort, isDayTitle } from './notesLook';
import { parseNote, setTaskDone } from './notesModel';
import { getNoteConflicts } from './notesOutbox';
import { nearestPlanned, notePlanLine } from './notesPlanned';
import { changeNotesMeta, getNotesMeta } from './notesStore';
import { getNoteTasks, markerOfTask } from './notesTasks';
import useSplitScrollSync from './useSplitScrollSync';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import CloudVersionsDialog from '../cloud/CloudVersionsDialog';
import MarkdownBlocks from '../markdown/MarkdownBlocks';
import CanvasFilePicker from './CanvasFilePicker';
import NoteArticleDialog from './NoteArticleDialog';
import NoteCanvasSheet from './NoteCanvasSheet';
import NoteConflictBar from './NoteConflictBar';
import NoteConflictView from './NoteConflictView';
import NoteEditorTools from './NoteEditorTools';
import NoteEmbed from './NoteEmbed';
import NoteLinks from './NoteLinks';
import NoteMenu from './NoteMenu';
import NotesMarkdownHelp from './NotesMarkdownHelp';
import NoteUnsentMark from './NoteUnsentMark';
import PvIcon from './PvIcon';
import PvSegment from './PvSegment';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import view from './NoteView.module.scss';
import kit from './PvKit.module.scss';

// Просьба открыть правку заметки с выделенным куском текста (ссылка, которую с графа убрать нельзя)
export type NoteEditRequest = { noteId: string; from: number; to: number; at: number };
// Режим заметки на компьютере: «Просмотр / Правка / Рядом» (правка слева, просмотр справа)
export type NoteMode = 'view' | 'edit' | 'split';

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planner: PlannerState;
  planned: PlannedItem[];
  // Где стоит заметка: `pane` — колонка компьютера (режимы одной кнопкой), `screen` — весь экран телефона
  // (своя шапка и стрелка назад), `panel` — панель рядом с графом либо холстом
  layout: 'pane' | 'screen' | 'panel';
  // «Связи» стоят под заметкой, когда для них нет отдельной колонки справа
  hasLinks?: boolean;
  // «Связи» без малого графа: заметка стоит в панели большого
  isGraphHidden?: boolean;
  editRequest?: NoteEditRequest;
  onBack?: NoneToVoidFunction;
  onOpenTitle: (title: string) => void;
  // `base` — текст, с которого начата правка: изменения заметки, пришедшие за время правки, сводятся с ней
  onSave: (noteId: string, text: string, base?: string) => Promise<boolean>;
  onRename: (noteId: string, title: string) => void;
  onDelete: (noteId: string) => void;
  // Перенос в другую папку: открыть выбор папки
  onPickFolder?: (noteId: string) => void;
  // Правка открыта/закрыта: раздел на это время убирает колонку «Связи»
  onEditingChange?: (isEditing: boolean) => void;
  // Заметку положили на холст из меню: открыть этот холст
  onOpenCanvas?: (canvasId: string) => void;
  // Щелчок по `#тегу` в тексте — поиск по нему (доска `ZdNotesX`, справка по разметке)
  onTag?: (tag: string) => void;
};

const MARKER = / \^(t[a-z0-9]{4,12})\s*$/;
// Сколько прошедших записей остаётся в «Запланировано» перед будущими
const PLANNED_PAST_MAX = 3;
// Высота строки редактора, если её не удалось узнать у браузера
const EDITOR_LINE_HEIGHT = 22;
// Столько заметок предлагается для незакрытой ссылки `[[…`
const LINK_SUGGEST_MAX = 3;
const NEXT_MODE: Record<NoteMode, NoteMode> = { view: 'edit', edit: 'split', split: 'view' };
const MODE_KEY = 'e';
// Ctrl+B / Ctrl+I в поле правки — жирный и курсив (доска `ZdNotesX`, справка по разметке)
const FORMAT_KEYS: Record<string, EditorTool> = { KeyB: 'bold', KeyI: 'italic' };

// Заметка по макету (доски `PhNotesMore`, `DeskNotes`): чтение с живыми ссылками, тегами и галочками; правка —
// текстом `.md` с кнопками разметки и подсказкой ссылок. На компьютере режимы «Просмотр / Правка / Рядом»
// переключаются одной кнопкой (Ctrl+E), на телефоне — «Изменить» и глазок просмотра в шапке
const NoteView = ({
  note, index, planner, planned, layout, hasLinks, isGraphHidden, editRequest, onBack, onOpenTitle, onSave,
  onRename, onDelete, onPickFolder, onEditingChange, onOpenCanvas, onTag,
}: OwnProps) => {
  const [draft, setDraft] = useState<string>();
  const [mode, setMode] = useState<NoteMode>('view');
  // Телефон и панель: правка и просмотр — одно окно, переключаются глазком в шапке
  const [isPreview, showPreview, hidePreview] = useFlag();
  const [caret, setCaret] = useState(0);
  const baseRef = useRef<string>();
  const editorRef = useRef<HTMLTextAreaElement>();
  const previewRef = useRef<HTMLElement>();
  const titleRef = useRef<HTMLInputElement>();
  const handledRequestRef = useRef<number>();
  const selectionRef = useRef<{ from: number; to: number }>();
  const [title, setTitle] = useState(note.title);
  const [isSaving, markSaving, unmarkSaving] = useFlag();
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();
  const [isMenuOpen, openMenu, closeMenu] = useFlag();
  const [isCloudPickerOpen, openCloudPicker, closeCloudPicker] = useFlag();
  const [isHelpOpen, openHelp, closeHelp] = useFlag();
  // Действие меню в своей шторке: статьёй в чат, на холст
  const [menuSheet, setMenuSheet] = useState<'article' | 'canvas' | 'versions'>();
  const [isConflictOpen, openConflict, closeConflict] = useFlag();
  const conflict = useDerivedState(getNoteConflicts).get(note.id);
  const isConflictShown = Boolean(conflict) && isConflictOpen;
  // Телефон: системное «назад» на экране расхождения закрывает его, а не заметку (доска `RpNotes`)
  useHistoryBack({ isActive: isConflictShown && layout === 'screen', onBack: closeConflict });
  const isPinned = useDerivedState(getNotesMeta).pinned.includes(note.id);
  const fileInputRef = useRef<HTMLInputElement>();
  const { showNotification } = getActions();

  const lang = useLang();

  const isCompact = layout !== 'pane';
  const isEditing = draft !== undefined;
  const isSplit = isEditing && !isCompact && mode === 'split';
  const isEditorShown = isEditing && !(isCompact && isPreview);
  const isPreviewShown = isEditing && (isCompact ? isPreview : isSplit);

  const startEdit = useLastCallback((next: NoteMode) => {
    if (draft === undefined) {
      baseRef.current = note.text;
      setDraft(note.text);
    }
    setMode(next);
  });

  const closeEdit = useLastCallback(() => {
    setDraft(undefined);
    setMode('view');
    hidePreview();
  });

  // Другая заметка — правка закрывается. Новое название той же заметки (своё переименование, дошедшее из хранилища,
  // либо с другого устройства) открытую правку не закрывает: сброс по названию терял редактор и набранный текст
  useEffect(() => {
    closeEdit();
    closeConflict();
  }, [note.id]);

  useEffect(() => {
    setTitle(note.title);
  }, [note.id, note.title]);

  // Просьба о правке выполняется один раз: открывает редактор и запоминает, что выделить
  useEffect(() => {
    if (!editRequest || editRequest.noteId !== note.id || handledRequestRef.current === editRequest.at) return;
    handledRequestRef.current = editRequest.at;
    selectionRef.current = { from: editRequest.from, to: editRequest.to };
    hidePreview();
    startEdit('edit');
  }, [editRequest, note.id]);

  // Редактор открылся по просьбе: кусок выделен и виден
  useEffect(() => {
    const selection = selectionRef.current;
    const editor = editorRef.current;
    if (!selection || !editor || draft === undefined) return;
    selectionRef.current = undefined;
    editor.focus();
    editor.setSelectionRange(selection.from, selection.to);
    setCaret(selection.to);
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || EDITOR_LINE_HEIGHT;
    const line = editor.value.slice(0, selection.from).split('\n').length - 1;
    editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 2);
  }, [draft]);

  const previewBlocks = useMemo(
    () => (draft !== undefined ? parseMarkdown(draft, note.title) : []), [draft, note.title],
  );

  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing, onEditingChange]);

  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);

  // «Рядом»: редактор и просмотр листаются вместе (по строкам текста)
  useSplitScrollSync(editorRef, previewRef, draft, isSplit);
  const isDaily = note.isDaily && isDayTitle(note.title);
  const parsed = useMemo(() => parseNote(note.text), [note.text]);
  const blocks = useMemo(() => parseMarkdown(note.text, note.title), [note.text, note.title]);
  // Встроенные файлы ищутся на личном диске
  const cloud = useDerivedState(getCloudData);
  const driveId = cloud?.rootId;
  const driveNodes = useMemo(() => (driveId ? getNodes(driveId, cloud) : []), [cloud, driveId]);
  const [today] = useState(() => toDayKey(new Date()));
  const [now] = useState(() => Date.now());

  // Пункты, ставшие задачами «Плана»: метка пункта → задача
  const taskByMarker = useMemo(() => (
    new Map(getNoteTasks(planner, note.id).map((task) => [markerOfTask(task), task]))
  ), [planner, note.id]);

  const shownPlanned = useMemo(() => {
    const past = planned.filter((item) => item.day && item.day < today);
    return [...past.slice(-PLANNED_PAST_MAX), ...planned.filter((item) => !item.day || item.day >= today)];
  }, [planned, today]);
  const nearest = nearestPlanned(planned, today);

  // Незакрытая ссылка `[[…` под курсором: заметки с таким началом названия и «новая», если точной нет
  const linkQuery = (isEditorShown && draft !== undefined ? findOpenLink(draft, caret) : undefined)?.query.trim();
  const linkTitles = useMemo(() => {
    if (linkQuery === undefined) return undefined;
    const query = linkQuery.toLowerCase();
    return index.notes
      .filter((item) => item.id !== note.id && item.title.toLowerCase().includes(query))
      .slice(0, LINK_SUGGEST_MAX)
      .map((item) => item.title);
  }, [index, note.id, linkQuery]);
  const newLinkTitle = linkQuery && !index.byTitle(linkQuery) ? linkQuery : undefined;

  const handleEdit = useLastCallback(() => {
    startEdit('edit');
  });

  const handleSave = useLastCallback(async () => {
    if (draft === undefined || isSaving) return;
    if (draft === baseRef.current) {
      closeEdit();
      return;
    }
    markSaving();
    const isSaved = await onSave(note.id, draft, baseRef.current);
    unmarkSaving();
    if (isSaved) closeEdit();
  });

  // «Просмотр» из правки — это «Готово»: набранное сохраняется
  const handleMode = useLastCallback((next: NoteMode) => {
    if (next === 'view') void handleSave();
    else startEdit(next);
  });

  // Ctrl+E — следующий режим: просмотр → правка → рядом → просмотр
  useEffect(() => {
    if (layout !== 'pane') return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== `Key${MODE_KEY.toUpperCase()}`) return;
      if (!getIsParvaneScreenShown('notes')) return;
      e.preventDefault();
      handleMode(NEXT_MODE[isEditing ? mode : 'view']);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [layout, mode, isEditing]);

  const handleDraft = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.currentTarget.value);
    setCaret(e.currentTarget.selectionStart);
  });

  const handleCaret = useLastCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCaret(e.currentTarget.selectionStart);
  });

  const handleEditorKey = useLastCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const tool = FORMAT_KEYS[e.code];
    if (!tool || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    e.preventDefault();
    handleTool(tool);
  });

  // Правка текста кнопкой. Текст и выделение ставятся в поле сразу, не дожидаясь отрисовки: набор, начатый
  // до неё, иначе продолжился бы с прежнего места
  const applyToEditor = useLastCallback((change: (state: EditorState) => EditorState) => {
    const editor = editorRef.current;
    if (!editor || draft === undefined) return;
    const next = change({ text: editor.value, from: editor.selectionStart, to: editor.selectionEnd });
    editor.value = next.text;
    editor.setSelectionRange(next.from, next.to);
    setDraft(next.text);
    setCaret(next.to);
  });

  const handleTool = useLastCallback((tool: EditorTool) => {
    applyToEditor((state) => applyEditorTool(state, tool));
  });

  const handleLinkSuggest = useLastCallback((linkTitle: string) => {
    applyToEditor((state) => completeOpenLink(state, linkTitle));
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

  const closeMenuSheet = useLastCallback(() => {
    setMenuSheet(undefined);
  });

  const handleMenuAction = useLastCallback((action: string) => {
    switch (action) {
      case 'rename':
        titleRef.current?.focus();
        titleRef.current?.select();
        break;
      case 'move':
        handleFolder();
        break;
      case 'plan':
        handlePlan();
        break;
      case 'day':
        handleOpenDay();
        break;
      case 'pin':
        void changeNotesMeta({ kind: 'pin', note: note.id, isPinned: !isPinned });
        break;
      case 'article':
      case 'canvas':
      case 'versions':
        setMenuSheet(action);
        break;
      case 'copy':
        copyTextToClipboard(`[[${note.title}]]`);
        showNotification({ message: lang('KnowledgeLinkCopied') });
        break;
      case 'delete':
        openDelete();
        break;
      default:
        break;
    }
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

  // «Выбрать заново» у пропавшего файла: в тексте заметки на его место встаёт выбранный файл диска
  const handleRepickEmbed = useLastCallback((name: string, path: string) => {
    void onSave(note.id, replaceEmbedTarget(note.text, name, path), note.text);
  });

  const renderEmbed = useLastCallback((embed: MdEmbed) => (
    <NoteEmbed embed={embed} noteId={note.id} driveId={driveId} nodes={driveNodes} onRepick={handleRepickEmbed} />
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
  const shownTitle = displayTitle(lang, note);
  const folderName = isDaily ? lang('KnowledgeDailyFolder')
    : note.folder ? folderCaption(note.folder) : lang('KnowledgeRoot');
  const edited = lang('KnowledgeEdited', { when: formatNoteEdited(lang, note.updatedAt, now) });

  const modeItems = useMemo((): PvSegmentItem<NoteMode>[] => [
    { value: 'view', label: lang('KnowledgeModeView') },
    { value: 'edit', label: lang('KnowledgeModeEdit') },
    { value: 'split', label: lang('KnowledgeModeSplit') },
  ], [lang]);

  const menuItems = useMemo(() => {
    const items: NoteMenuItem[] = [];
    if (!isDaily) items.push({ action: 'rename', label: lang('KnowledgeFolderRename'), icon: 'edit' });
    if (!isDaily && onPickFolder) items.push({ action: 'move', label: lang('KnowledgeMoveNote'), icon: 'folder' });
    items.push(isDaily
      ? { action: 'day', label: lang('KnowledgeOpenDay'), icon: 'cal' }
      : { action: 'plan', label: lang('KnowledgePlan'), icon: 'cal' });
    items.push({ action: 'pin', label: lang(isPinned ? 'KnowledgeUnpin' : 'KnowledgePin'), icon: 'up' });
    // Телефон — «Отправить статьёй в чат» (`XpNotes`), меню компьютера — «Отправить в чат…» (`ZdNotesX`)
    items.push({
      action: 'article', label: lang(isCompact ? 'KnowledgeSendArticle' : 'KnowledgeSendToChat'), icon: 'chat',
    });
    items.push({ action: 'canvas', label: lang('KnowledgeAddToCanvas'), icon: 'board' });
    items.push({ action: 'copy', label: lang('KnowledgeCopyLink', { title: note.title }), icon: 'link' });
    // История версий заметки (CLOUD-3): тот же механизм, что у файлов «Файлов»
    items.push({ action: 'versions', label: lang('ParvaneCloudVersions'), icon: 'restore' });
    items.push({
      action: 'delete', label: lang('KnowledgeDelete'), icon: 'trash', isDanger: true,
    });
    return items;
  }, [lang, isDaily, onPickFolder, isPinned, isCompact, note.title]);

  // Подзаголовок шторки действий: «папка · N связей» (доска `XpNotes`)
  const linkCount = countNoteLinks(index, note.id);
  const linkCaption = lang('KnowledgeLinksCount', { count: linkCount }, { pluralValue: linkCount });
  const menuSubtitle = `${folderName} · ${linkCaption}`;

  function renderMore() {
    return (
      <span className={view.more}>
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('AccDescrMoreOptions')}
          title={lang('AccDescrMoreOptions')}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          data-note-menu
          onClick={isMenuOpen ? closeMenu : openMenu}
        >
          <PvIcon name="dots" />
        </button>
        <NoteMenu
          isOpen={isMenuOpen}
          title={shownTitle}
          subtitle={menuSubtitle}
          items={menuItems}
          isSheet={isCompact}
          onPick={handleMenuAction}
          onClose={closeMenu}
        />
      </span>
    );
  }

  function renderDone() {
    return (
      <button type="button" className={view.barText} disabled={isSaving} data-note-bar-edit onClick={handleSave}>
        {lang('KnowledgeSave')}
      </button>
    );
  }

  // Шапка телефона и панели: «Изменить» и «Ещё»; в правке — крестик, глазок просмотра и «Готово»
  function renderCompactBar() {
    return (
      <header className={buildClassName(view.bar, view.barCompact)} data-note-bar>
        {isConflictShown ? (
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('KnowledgeBack')}
            data-note-conflict-back
            onClick={closeConflict}
          >
            <PvIcon name="left" />
          </button>
        ) : isEditing ? (
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('KnowledgeCancelEdit')}
            title={lang('KnowledgeCancelEdit')}
            onClick={closeEdit}
          >
            <PvIcon name="x" />
          </button>
        ) : onBack && (
          <button type="button" className={kit.ib} aria-label={lang('KnowledgeBack')} onClick={onBack}>
            <PvIcon name="left" />
          </button>
        )}
        <h1 className={buildClassName(view.barTitle, !isEditing && !onBack && view.barTitleLead)}>
          {layout === 'screen' || isConflictShown ? shownTitle : folderName}
        </h1>
        {isConflictShown ? undefined : isEditing ? (
          <>
            <button
              type="button"
              className={buildClassName(kit.ib, isPreview && view.ibOn)}
              aria-label={lang(isPreview ? 'KnowledgePreviewHide' : 'KnowledgePreviewShow')}
              title={lang(isPreview ? 'KnowledgePreviewHide' : 'KnowledgePreviewShow')}
              aria-pressed={isPreview}
              data-note-preview-toggle
              onClick={isPreview ? hidePreview : showPreview}
            >
              <PvIcon name="eye" />
            </button>
            {renderDone()}
          </>
        ) : (
          <>
            <button type="button" className={view.barText} data-note-bar-edit onClick={handleEdit}>
              {lang('KnowledgeEdit')}
            </button>
            {renderMore()}
          </>
        )}
      </header>
    );
  }

  // Шапка колонки компьютера: путь, режимы одной кнопкой, в правке — «Отмена» и «Готово»
  function renderPaneBar() {
    return (
      <header className={view.bar} data-note-bar>
        <span className={view.crumb} title={`${folderName} / ${shownTitle}`}>
          {/* Папка в пути — кнопка переноса в другую папку (на компьютере строки «папка · изменена» над заголовком
              нет, доска `DeskNotes`) */}
          {onPickFolder && !isDaily ? (
            <button
              type="button"
              className={view.crumbFolder}
              aria-label={`${folderName}. ${lang('KnowledgeMoveNote')}`}
              title={lang('KnowledgeMoveNote')}
              data-note-folder={note.folder}
              onClick={handleFolder}
            >
              {folderName}
            </button>
          ) : <span data-note-folder={note.folder}>{folderName}</span>}
          {` / ${shownTitle}`}
        </span>
        <PvSegment
          className={view.modes}
          items={modeItems}
          value={isEditing ? mode : 'view'}
          label={lang('KnowledgeModeLabel')}
          onChange={handleMode}
        />
        <kbd className={view.kbd}>{`Ctrl+${MODE_KEY.toUpperCase()}`}</kbd>
        {isEditing && (
          <>
            <button type="button" className={buildClassName(view.barText, view.barTextMuted)} onClick={closeEdit}>
              {lang('Cancel')}
            </button>
            {renderDone()}
          </>
        )}
        {renderMore()}
      </header>
    );
  }

  function renderEditor() {
    return (
      <div className={view.editPane}>
        <textarea
          ref={editorRef}
          id="knowledge-note-editor"
          className={view.editor}
          value={draft}
          placeholder={lang('KnowledgeEditorPlaceholder')}
          aria-label={lang('KnowledgeEditorLabel')}
          spellCheck={false}
          onChange={handleDraft}
          onSelect={handleCaret}
          onKeyDown={handleEditorKey}
          onDragOver={handleEditorDragOver}
          onDrop={handleEditorDrop}
          onPaste={handleEditorPaste}
        />
        <NoteEditorTools
          linkTitles={linkTitles}
          newLinkTitle={newLinkTitle}
          onTool={handleTool}
          onLink={handleLinkSuggest}
          onFile={handleChooseFiles}
          onCloudFile={openCloudPicker}
          onHelp={openHelp}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className={styles.hiddenInput}
          data-note-insert-input
          onChange={handlePickedFiles}
        />
      </div>
    );
  }

  function renderPreview() {
    return (
      <section
        ref={previewRef}
        className={buildClassName(view.previewPane, 'custom-scroll')}
        aria-label={lang('KnowledgePreviewTitle')}
        data-note-preview
      >
        <div className={styles.md}>
          <MarkdownBlocks
            blocks={previewBlocks}
            renderNote={renderNoteLink}
            renderEmbed={renderEmbed}
            taskTail={taskTail}
          />
        </div>
      </section>
    );
  }

  function renderPlanned() {
    return (
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
    );
  }

  function renderReading() {
    return (
      <div className={buildClassName(view.scroll, layout !== 'panel' && 'custom-scroll')}>
        <div className={view.body}>
          {layout === 'pane' ? (
            // Колонка компьютера: папка — в пути шапки, время правки — внизу «Связей» (доска `DeskNotes`)
            <NoteUnsentMark noteId={note.id} className={view.metaUnsent} />
          ) : (
            <div className={view.meta}>
              {onPickFolder && !isDaily ? (
                <button
                  type="button"
                  className={view.metaFolder}
                  aria-label={`${folderName}. ${lang('KnowledgeMoveNote')}`}
                  title={lang('KnowledgeMoveNote')}
                  data-note-folder={note.folder}
                  onClick={handleFolder}
                >
                  {folderName}
                </button>
              ) : <span>{folderName}</span>}
              <span>{` · ${edited}`}</span>
              <NoteUnsentMark noteId={note.id} className={view.metaUnsent} />
            </div>
          )}
          {isDaily ? (
            <h2 className={view.title}>{shownTitle}</h2>
          ) : (
            <input
              ref={titleRef}
              className={buildClassName(view.title, view.titleInput)}
              value={title}
              maxLength={NOTE_TITLE_MAX}
              aria-label={lang('KnowledgeNoteTitle')}
              onChange={handleTitle}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKey}
            />
          )}
          {(Boolean(properties.length) || nearest) && (
            <div className={styles.props}>
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
          )}
          <div className={styles.md} data-note-body>
            <MarkdownBlocks
              blocks={blocks}
              renderNote={renderNoteLink}
              renderEmbed={renderEmbed}
              onTag={onTag}
              onToggleTask={handleToggleTask}
              taskTail={taskTail}
            />
          </div>
          {!isDaily && Boolean(shownPlanned.length) && renderPlanned()}
          {hasLinks && (
            <NoteLinks
              className={styles.linksInline}
              note={note}
              index={index}
              planned={planned}
              isGraphHidden={isGraphHidden}
              isBacklinksOnly={layout === 'screen'}
              onOpenTitle={onOpenTitle}
            />
          )}
          {isDaily ? (
            <button
              type="button"
              className={buildClassName(kit.btn, view.wideButton)}
              data-note-open-day
              onClick={handleOpenDay}
            >
              {lang('KnowledgeOpenDay')}
            </button>
          ) : layout !== 'pane' && (
            // На компьютере «Запланировать» — пункт меню «⋮» (доска `DeskNotes` без кнопки внизу)
            <button
              type="button"
              className={buildClassName(kit.btn, view.wideButton)}
              data-note-plan
              onClick={handlePlan}
            >
              {lang('KnowledgePlan')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <article
      className={buildClassName(view.note, layout === 'panel' && view.notePanel)}
      data-note-id={note.id}
      data-note-title={note.title}
      data-note-mode={isEditing ? (isCompact ? 'edit' : mode) : 'view'}
    >
      {isCompact ? renderCompactBar() : !isConflictShown && renderPaneBar()}
      {conflict && !isConflictOpen && <NoteConflictBar onOpen={openConflict} />}
      {isConflictShown ? (
        <NoteConflictView
          conflict={conflict}
          layout={layout === 'pane' ? 'columns' : 'places'}
          onDone={closeConflict}
        />
      ) : isEditing ? (
        <div
          className={buildClassName(view.work, isSplit && view.workSplit)}
          data-note-edit={isCompact ? (isPreview ? 'preview' : 'editor') : isSplit ? 'split' : 'editor'}
        >
          {isEditorShown && renderEditor()}
          {isPreviewShown && renderPreview()}
        </div>
      ) : renderReading()}
      <NoteArticleDialog note={menuSheet === 'article' ? note : undefined} onClose={closeMenuSheet} />
      <CloudVersionsDialog
        container={menuSheet === 'versions' ? driveId : undefined}
        nodeId={note.id}
        onClose={closeMenuSheet}
      />
      <NoteCanvasSheet
        note={menuSheet === 'canvas' ? note : undefined}
        onOpenCanvas={onOpenCanvas}
        onClose={closeMenuSheet}
      />
      <PvSheet isOpen={isHelpOpen} title={lang('KnowledgeMdHelp')} isWide onClose={closeHelp}>
        <NotesMarkdownHelp />
      </PvSheet>
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
