import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerState } from '../planner/plannerModel';
import type { GraphPick } from './NotesGraph';
import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';
import type { NoteEditRequest } from './NoteView';

import buildClassName from '../../../util/buildClassName';
import { formatRepeat } from '../planner/plannerFormat';
import { displayTitle, formatDayShort } from './notesLook';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import NoteView from './NoteView';
import PvIcon from './PvIcon';
import PvResizer from './PvResizer';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

// Пределы ширины панели, которую меняет пользователь (px)
const PANEL_MIN = 320;
const PANEL_MAX = 900;

type OwnProps = {
  // Выбранная точка графа; без неё панель закрыта (лист на телефоне доигрывает закрытие с прежним содержимым)
  pick?: GraphPick;
  // Заметка точки: у заметки и заметки дня; у «заметки, которой ещё нет» — если её успели создать
  note?: NoteEntry;
  // Запись «Плана» точки
  record?: PlannedItem;
  index: NotesIndex;
  planner: PlannerState;
  planned: PlannedItem[];
  // Узкий экран: лист снизу поверх графа вместо острова справа
  isSheet?: boolean;
  editRequest?: NoteEditRequest;
  onClose: NoneToVoidFunction;
  onOpenInNotes: (noteId: string) => void;
  // «Связать»: следующая нажатая на графе заметка получит ссылку из этой
  // Режим «Связать» есть только на графе; рядом с холстом кнопки нет
  onLinkStart?: (noteId: string) => void;
  onCreate: (title: string) => void;
  onOpenInPlan: (record: PlannedItem) => void;
  onOpenTitle: (title: string) => void;
  onSave: (noteId: string, text: string, base?: string) => Promise<boolean>;
  onRename: (noteId: string, title: string) => void;
  onDelete: (noteId: string) => void;
  onPickFolder: (noteId: string) => void;
};

type Shown = { pick: GraphPick; note?: NoteEntry; record?: PlannedItem };

// Панель графа: выбранная точка читается и правится, не уходя с графа. Заметка — настоящая `NoteView` (текст,
// правка, «Запланировано», обратные ссылки); заметки ещё нет — предложение создать; запись «Плана» — её день
// и время с переходом в «План»
const GraphPanel = ({
  pick, note, record, index, planner, planned, isSheet, editRequest, onClose, onOpenInNotes, onLinkStart, onCreate,
  onOpenInPlan, onOpenTitle, onSave, onRename, onDelete, onPickFolder,
}: OwnProps) => {
  const lang = useLang();

  const current = useMemo((): Shown | undefined => (pick ? { pick, note, record } : undefined), [pick, note, record]);
  const shown = useCurrentOrPrev(current, true);
  const shownNote = shown?.note;
  const shownRecord = shown?.record;

  const handleOpenInNotes = useLastCallback(() => {
    if (shownNote) onOpenInNotes(shownNote.id);
  });

  const handleLinkStart = useLastCallback(() => {
    if (shownNote) onLinkStart?.(shownNote.id);
  });

  const handleCreate = useLastCallback(() => {
    if (shown) onCreate(shown.pick.title);
  });

  const handleOpenInPlan = useLastCallback(() => {
    if (shownRecord) onOpenInPlan(shownRecord);
  });

  if (!shown) return undefined;

  const kind = shownNote ? (shownNote.isDaily ? 'day' : 'note') : shown.pick.kind;
  const title = shownNote ? displayTitle(lang, shownNote) : shownRecord ? shownRecord.name : shown.pick.title;
  // Связь ведут от обычной заметки: заметки дней в правке связей не участвуют
  const isLinkable = Boolean(shownNote && !shownNote.isDaily);

  function renderRecord(item: PlannedItem) {
    const when = item.day ? `${formatDayShort(lang, item.day)}${item.time ? `, ${item.time}` : ''}`
      : item.due ? lang('PlannerDueValue', { date: formatDayShort(lang, item.due) }) : lang('KnowledgeNoDate');
    return (
      <div className={styles.graphInfo} style={`--c: var(--pv-${item.kind})`} data-graph-panel-record={item.key}>
        <span className={buildClassName(kit.caps, styles.graphInfoKind)}>
          {lang(item.kind === 'task' ? 'KnowledgeGraphKindTask' : 'KnowledgeGraphKindEvent')}
        </span>
        <h2 className={styles.graphInfoTitle}>{item.name}</h2>
        <p className={styles.graphInfoLine}>
          <PvIcon name="cal" isSmall />
          {when}
          {item.repeat && ` · ${formatRepeat(lang, item.repeat)}`}
          {item.isDone && ` · ${lang('PlannerStatusDone')}`}
        </p>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          data-graph-panel-plan
          onClick={handleOpenInPlan}
        >
          <PvIcon name="open" isSmall />
          {lang('KnowledgeGraphOpenInPlan')}
        </button>
      </div>
    );
  }

  const body = shownNote ? (
    <NoteView
      note={shownNote}
      index={index}
      planner={planner}
      planned={planned}
      hasLinks
      isGraphHidden
      editRequest={editRequest}
      onOpenTitle={onOpenTitle}
      onSave={onSave}
      onRename={onRename}
      onDelete={onDelete}
      onPickFolder={onPickFolder}
    />
  ) : shownRecord ? renderRecord(shownRecord) : (
    <div className={styles.graphInfo} style="--c: var(--pv-faint)">
      <span className={buildClassName(kit.caps, styles.graphInfoKind)}>{lang('KnowledgeGraphKindMissing')}</span>
      <h2 className={styles.graphInfoTitle}>{shown.pick.title}</h2>
      <p className={styles.graphInfoLine}>{lang('KnowledgeGraphMissingText')}</p>
      <button
        type="button"
        className={buildClassName(kit.btn, kit.btnAcc)}
        data-graph-panel-create
        onClick={handleCreate}
      >
        <PvIcon name="plus" isSmall />
        {lang('KnowledgeGraphCreate')}
      </button>
    </div>
  );

  const buttons = shownNote && (
    <>
      {isLinkable && onLinkStart && (
        <button
          type="button"
          className={buildClassName(kit.pill, styles.graphPanelLink)}
          title={lang('KnowledgeGraphConnectTitle')}
          data-graph-link-start
          onClick={handleLinkStart}
        >
          <PvIcon name="link" isSmall />
          {lang('KnowledgeGraphConnect')}
        </button>
      )}
      <button
        type="button"
        className={kit.ib}
        aria-label={lang('KnowledgeGraphOpenInNotes')}
        title={lang('KnowledgeGraphOpenInNotes')}
        data-graph-panel-open
        onClick={handleOpenInNotes}
      >
        <PvIcon name="open" />
      </button>
    </>
  );

  if (isSheet) {
    return (
      <PvSheet
        isOpen={Boolean(pick)}
        title={title}
        className={styles.graphSheet}
        headAfter={buttons}
        onClose={onClose}
      >
        <div data-graph-panel={shown.pick.id} data-graph-panel-kind={kind}>{body}</div>
      </PvSheet>
    );
  }

  return (
    <aside
      className={buildClassName(kit.island, styles.graphPanel)}
      aria-label={title}
      data-graph-panel={shown.pick.id}
      data-graph-panel-kind={kind}
    >
      <PvResizer panel="graph-note" edge="start" min={PANEL_MIN} max={PANEL_MAX} />
      <header className={buildClassName(kit.hdr, styles.graphPanelHead)}>
        <h1 className={buildClassName(kit.hdrSmall, kit.grow, styles.graphPanelTitle)}>{title}</h1>
        {buttons}
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('Close')}
          title={lang('Close')}
          data-graph-panel-close
          onClick={onClose}
        >
          <PvIcon name="x" />
        </button>
      </header>
      <div className={buildClassName(styles.graphPanelBody, 'custom-scroll')}>{body}</div>
    </aside>
  );
};

export default memo(GraphPanel);
