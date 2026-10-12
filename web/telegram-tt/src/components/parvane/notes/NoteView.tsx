import type { TeactNode } from '../../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from '../planner/plannerModel';
import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { formatRepeat } from '../planner/plannerFormat';
import { toDayKey } from '../planner/plannerModel';
import { displayTitle, formatDayShort, isDayTitle } from './notesLook';
import { parseNote, setTaskDone } from './notesModel';
import { nearestPlanned } from './notesPlanned';
import { getNoteTasks, markerOfTask } from './notesTasks';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import NoteLinks from './NoteLinks';
import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planner: PlannerState;
  planned: PlannedItem[];
  // Узкий экран: заметка занимает весь раздел, сверху своя шапка и стрелка назад
  onBack?: NoneToVoidFunction;
  // «Связи» стоят под заметкой, когда для них нет отдельного острова справа
  hasLinks?: boolean;
  onOpenTitle: (title: string) => void;
  onSave: (noteId: string, text: string) => Promise<boolean>;
  onRename: (noteId: string, title: string) => void;
  onDelete: (noteId: string) => void;
};

const TITLE_MAX_LENGTH = 120;
const INLINE = /(\[\[[^\]\n]+\]\]|`[^`\n]+`|\*\*[^*\n]+\*\*|(?:^|\s)#[\p{L}\d_/-]+)/gu;
const TASK_LINE = /^(\s*)[-*+] \[( |x|X)\](?: (.*))?$/;
const LIST_LINE = /^(\s*)[-*+] (.*)$/;
const HEADING = /^(#{1,3}) (.*)$/;
const MARKER = / \^(t[a-z0-9]{4,12})\s*$/;
const FENCE = '```';
// Сколько прошедших записей остаётся в «Запланировано» перед будущими
const PLANNED_PAST_MAX = 3;

// Заметка: чтение с живыми ссылками, тегами и круглыми галочками; правка — текстом `.md`.
// Ниже — «Запланировано» (записи «Плана» со ссылкой сюда), на узком экране ещё и «Связи»
const NoteView = ({
  note, index, planner, planned, onBack, hasLinks, onOpenTitle, onSave, onRename, onDelete,
}: OwnProps) => {
  const [draft, setDraft] = useState<string>();
  const [title, setTitle] = useState(note.title);
  const [isSaving, markSaving, unmarkSaving] = useFlag();
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();

  const lang = useLang();

  useEffect(() => {
    setDraft(undefined);
    setTitle(note.title);
  }, [note.id, note.title]);

  const isEditing = draft !== undefined;
  const isDaily = note.isDaily && isDayTitle(note.title);
  const parsed = useMemo(() => parseNote(note.text), [note.text]);
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
    const isSaved = await onSave(note.id, draft);
    unmarkSaving();
    if (isSaved) setDraft(undefined);
  });

  const handleTitle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.currentTarget.value);
  });

  // Значение берётся из самого поля: уход фокуса может прийти раньше перерисовки с набранным текстом
  const handleTitleBlur = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value.trim();
    if (next && next !== note.title) onRename(note.id, next);
    else setTitle(note.title);
  });

  const handleTitleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  });

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const line = Number(e.currentTarget.dataset.line);
    void onSave(note.id, setTaskDone(note.text, line, e.currentTarget.checked));
  });

  const handleLink = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenTitle(e.currentTarget.dataset.title!);
  });

  const handleDelete = useLastCallback(() => {
    closeDelete();
    onDelete(note.id);
  });

  const formatWhen = (day?: string, time?: string, due?: string) => {
    if (day) return `${formatDayShort(lang, day)}${time ? ` ${time}` : ''}`;
    return due ? lang('PlannerDueValue', { date: formatDayShort(lang, due) }) : '';
  };

  const renderInline = (text: string) => text.split(INLINE).map((part, i) => {
    const key = `${i}${part}`;
    if (part.startsWith('[[')) {
      const [target, alias] = part.slice(2, -2).split('|');
      const isMissing = !index.byTitle(target);
      return (
        <button
          key={key}
          type="button"
          className={buildClassName(styles.link, isMissing && styles.linkMissing)}
          data-title={target.trim()}
          title={isMissing ? lang('KnowledgeMissingNote') : undefined}
          onClick={handleLink}
        >
          {(alias || target).trim()}
        </button>
      );
    }
    if (part.startsWith('`')) return <code key={key} className={styles.code}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^\s?#[\p{L}\d_/-]+$/u.test(part)) return <span key={key} className={styles.tag}>{part}</span>;
    return part;
  });

  // Построчно: заголовки, пункты с галочками, списки, код; пустая строка — отступ
  const renderBody = () => {
    const lines = note.text.split('\n');
    const bodyStart = lines.length - parsed.body.split('\n').length;
    const ownTitle = note.title.trim().toLowerCase();
    const out: TeactNode[] = [];
    let isCode = false;
    let hasContent = false;
    lines.forEach((line, i) => {
      if (i < bodyStart) return;
      if (line.trim().startsWith(FENCE)) {
        isCode = !isCode;
        return;
      }
      if (isCode) {
        out.push(<pre key={i} className={styles.pre}>{line}</pre>);
        return;
      }
      const task = TASK_LINE.exec(line);
      if (task) {
        const isDone = task[2] !== ' ';
        const text = task[3] || '';
        const planTask = taskByMarker.get(MARKER.exec(text)?.[1] || '');
        const when = planTask && formatWhen(planTask.day, planTask.start, planTask.due);
        hasContent = true;
        out.push(
          <label
            key={i}
            className={buildClassName(styles.item, isDone && styles.itemDone)}
            style={`padding-inline-start: ${task[1].length * 0.5}rem`}
          >
            <input
              type="checkbox"
              className={styles.check}
              checked={isDone}
              data-line={i}
              onChange={handleToggle}
            />
            <span className={styles.itemText}>
              {renderInline(text.replace(MARKER, ''))}
              {when && (
                <span className={styles.dateTag}>
                  <PvIcon name="cal" className={styles.dateTagIcon} />
                  {when}
                </span>
              )}
            </span>
          </label>,
        );
        return;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        // Первый заголовок, повторяющий название, не показывается: название стоит над текстом
        if (!hasContent && heading[2].trim().toLowerCase() === ownTitle) return;
        hasContent = true;
        out.push(
          <div
            key={i}
            role="heading"
            aria-level={heading[1].length + 1}
            className={buildClassName(styles.heading, styles[`heading${heading[1].length}`])}
          >
            {renderInline(heading[2])}
          </div>,
        );
        return;
      }
      const item = LIST_LINE.exec(line);
      if (item) {
        hasContent = true;
        out.push(
          <div key={i} className={styles.item} style={`padding-inline-start: ${item[1].length * 0.5}rem`}>
            <span className={styles.bullet}>•</span>
            <span className={styles.itemText}>{renderInline(item[2])}</span>
          </div>,
        );
        return;
      }
      if (!line.trim()) {
        // Пустые строки перед текстом (после скрытого заголовка) не дают отступа
        if (hasContent) out.push(<div key={i} className={styles.gap} />);
        return;
      }
      hasContent = true;
      out.push(<div key={i}>{renderInline(line)}</div>);
    });
    return out;
  };

  const properties = Object.entries(parsed.properties);
  const folderName = isDaily ? lang('KnowledgeDailyFolder') : note.folder || lang('KnowledgeRoot');

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
            maxLength={TITLE_MAX_LENGTH}
            aria-label={lang('KnowledgeNoteTitle')}
            onChange={handleTitle}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKey}
          />
        )}
        <div className={styles.props}>
          <span className={styles.prop}>{folderName}</span>
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
          <textarea
            id="knowledge-note-editor"
            className={buildClassName(kit.textarea, styles.editor)}
            value={draft}
            placeholder={lang('KnowledgeEditorPlaceholder')}
            aria-label={note.title}
            onChange={handleDraft}
          />
        ) : (
          <div className={styles.md} data-note-body>{renderBody()}</div>
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
        {!isDaily && (
          <section className={buildClassName(kit.card, styles.planned)} data-note-planned>
            <div className={kit.cardHead}>
              <h3 className={buildClassName(kit.cardTitle, kit.grow)}>{lang('KnowledgePlanned')}</h3>
              <span className={styles.plannedHint}>{lang('KnowledgePlannedHint')}</span>
            </div>
            {!shownPlanned.length && <p className={styles.mutedLine}>{lang('KnowledgePlannedEmpty')}</p>}
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
            onOpenTitle={onOpenTitle}
          />
        )}
      </div>
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
