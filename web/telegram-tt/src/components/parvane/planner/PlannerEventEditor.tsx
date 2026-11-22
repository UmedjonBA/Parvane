import { memo, useState } from '../../../lib/teact/teact';

import type {
  PlannerEvent, PlannerEventError, PlannerRepeat, PlannerSeriesItem, PlannerState, PlannerStep,
} from './plannerModel';
import type { PlannerRepeatDraft } from './PlannerRepeatFields';
import type { PlannerDescriptionScope as DescriptionScope } from './plannerSeriesEdit';
import type { PlannerPromptScope } from './PlannerSeriesPrompt';

import buildClassName from '../../../util/buildClassName';
import {
  formatDurationValue, getEndByDuration, getOnlyNewTime, getSpanMinutes, parseDuration,
} from './plannerEditorFormat';
import { formatRepeatShort } from './plannerFormat';
import {
  ALL_DAY_END, ALL_DAY_START, detachInstance, excludeInstance, instanceKey, removeSeries, setEventStepDone,
  splitSeries, toDayKey, toTime, truncateSeries, updateSeries, validateEvent, validateRepeat,
} from './plannerModel';
import {
  changedFields, detachWithDescription, getDescriptionScope, patchCopies, seriesOfCopy,
  setDescription as writeDescription, updateFromCopy,
} from './plannerSeriesEdit';
import { changeSeriesRule, nearestSeriesDay, sameRepeat } from './plannerSeriesRule';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import Icon from '../../common/icons/Icon';
import TextArea from '../../ui/TextArea';
import PvSwitch from '../notes/PvSwitch';
import {
  PLANNER_SIDE_FORM_ID, PlannerCardCaption, PlannerCardRow, PlannerRepeatRow,
} from './PlannerCardRow';
import PlannerDateField from './PlannerDateField';
import PlannerDescriptionScope from './PlannerDescriptionScope';
import PlannerField from './PlannerField';
import PlannerFreeTime from './PlannerFreeTime';
import PlannerListPicker, { PlannerColorSwatches } from './PlannerListPicker';
import PlannerRemindSelect from './PlannerRemindSelect';
import { draftToRepeat, repeatToDraft } from './PlannerRepeatFields';
import PlannerSeriesPrompt from './PlannerSeriesPrompt';
import PlannerSteps from './PlannerSteps';
import { REPEAT_ERROR_KEYS } from './PlannerTaskForm';

import styles from './Planner.module.scss';
import more from './PlannerEditor.module.scss';

type OwnProps = {
  state: PlannerState;
  // Событие либо экземпляр ряда (`instanceDay`)
  event: PlannerEvent;
  onBack: NoneToVoidFunction;
  // Правка создала другую запись (отделённый день, продолжение ряда): карточка переходит на неё
  onOpenEvent: (eventId: string, day: string) => void;
};

const EVENT_ERROR_KEYS = {
  name: 'PlannerErrorName',
  time: 'PlannerErrorEventTime',
  repeat: 'PlannerErrorEventRepeat',
  interval: 'PlannerErrorRepeatInterval',
  weekdays: 'PlannerErrorRepeatWeekdays',
  monthDay: 'PlannerErrorRepeatMonthDay',
  startDay: 'PlannerErrorRepeatStart',
  endDay: 'PlannerErrorRepeatEnd',
  count: 'PlannerErrorRepeatCount',
} as const satisfies Record<PlannerEventError, string>;

const NAME_MAX_LENGTH = 160;
const NO_STEPS: PlannerStep[] = [];
// Движок принимает до 4000 байт: запас на кириллицу
const DESCRIPTION_MAX_LENGTH = 2000;
// Событие, снятое с «весь день», получает обычное время
const DEFAULT_START = '09:00';
const DEFAULT_END = '10:00';
// Ширина, до которой «План» — одна колонка (`Planner.module.scss`)
const NARROW_WIDTH = 925;

// Поля карточки, которые пишутся правкой
type Values = {
  name: string;
  description: string;
  start: string;
  end: string;
  day: string;
  isAllDay: boolean;
  isHoliday: boolean;
  color: number;
  project: string;
  remind?: number;
};

// `ownDescription` — описание только этого дня: остальные поля правятся в выбранном объёме, день отделяется
// `rule` — вместе с полями меняется правило повтора; без правила — «Не повторяется»
type Pending = { kind: 'save'; patch: Partial<PlannerEvent>; ownDescription?: string; targetDay: string }
  | { kind: 'rule'; repeat?: PlannerRepeat; patch: Partial<PlannerEvent>; ownDescription?: string; targetDay: string }
  | { kind: 'delete' }
  // Отделённый день ряда: `next` — вся карточка, `fields` — изменённое, что можно отдать всему ряду
  | { kind: 'copy'; next: Partial<PlannerEvent>; fields: Partial<PlannerEvent> };

// Правка события (spec 011; по месту — доска `DkPlanMore`): каждое поле пишется сразу по завершении ввода, у
// экземпляра ряда — после выбора объёма правки. Правило повтора — кнопкой «Сохранить повтор», как у задачи
const PlannerEventEditor = ({
  state, event, onBack, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();
  const { width } = useWindowSize();
  const isNarrow = width <= NARROW_WIDTH;

  const [fieldsRevision, setFieldsRevision] = useState(0);
  const [values, setValues] = useState<Values>(() => ({
    name: event.name,
    description: event.description || '',
    start: event.start,
    end: event.end,
    day: event.instanceDay || event.day || '',
    isAllDay: Boolean(event.isAllDay),
    isHoliday: Boolean(event.isHoliday),
    color: event.color || 0,
    project: event.project || '',
    remind: event.remind,
  }));
  // Чьё описание: всех повторов либо только этого дня; `undefined` — запись не из ряда, галочки нет
  const [descriptionScope, setDescriptionScope] = useState<DescriptionScope | undefined>(
    () => getDescriptionScope(state, 'event', event),
  );
  const [repeatDraft, setRepeatDraft] = useState<PlannerRepeatDraft>(
    () => repeatToDraft(event.repeat, event.day || ''),
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<Pending>();
  const [today] = useState(() => toDayKey(new Date()));

  const isInstance = Boolean(event.repeat && event.instanceDay);
  const instanceDay = event.instanceDay;

  // Карточка остаётся на записи этого дня: отделённой копии, продолжении ряда либо самом ряде
  function reopen(item: PlannerSeriesItem | undefined, day = today) {
    if (!item) {
      onBack();
      return;
    }
    onOpenEvent(item.id, item.repeat ? nearestSeriesDay(item, day) || day : (item.day || day));
  }

  const applyScope = useLastCallback((scope: PlannerPromptScope, action: Pending) => {
    if (action.kind === 'delete') {
      updatePlanner((draft) => {
        if (scope === 'one') excludeInstance(draft, 'event', event.id, instanceDay!);
        else if (scope === 'following') truncateSeries(draft, 'event', event.id, instanceDay!);
        else removeSeries(draft, 'event', event.id);
      }, lang('PlannerNoticeEventDeleted'));
      onBack();
      return;
    }
    if (action.kind === 'copy') {
      updatePlanner((draft) => {
        const target = saveOwn(draft, action.next);
        if (target && scope === 'all') updateFromCopy(draft, 'event', target, action.fields);
      }, lang('PlannerNoticeEventUpdated', { name: action.next.name || event.name }));
      return;
    }
    const { patch, ownDescription, targetDay } = action;
    const own = ownDescription === undefined ? {} : { description: ownDescription || undefined };
    let result: PlannerSeriesItem | undefined;
    if (action.kind === 'rule') {
      const { repeat } = action;
      updatePlanner((draft) => {
        if (!repeat) {
          // Без повтора: день остаётся разовой записью со всеми правками карточки
          const ruleScope = scope === 'stop' ? 'stop' : 'one';
          result = changeSeriesRule(draft, 'event', event.id, instanceDay!, undefined, ruleScope, {
            ...patch, ...own, day: targetDay,
          });
          return;
        }
        // Дни ряда задаёт новое правило: дата из карточки на него не влияет
        result = changeSeriesRule(
          draft, 'event', event.id, instanceDay!, repeat, scope === 'following' ? 'following' : 'all', patch,
        );
        if (result && ownDescription !== undefined) {
          detachWithDescription(draft, 'event', result.id, instanceDay!, ownDescription);
        }
      }, lang(repeat ? 'PlannerNoticeEventUpdated' : 'PlannerNoticeRepeatStopped', { name: patch.name || event.name }));
      reopen(result, instanceDay);
      return;
    }
    updatePlanner((draft) => {
      if (scope === 'one' || scope === 'stop') {
        // «Не повторять с этого дня» (доска `XpPlan`): день — разовой записью с правкой, ряд кончается
        result = scope === 'stop'
          ? changeSeriesRule(draft, 'event', event.id, instanceDay!, undefined, 'stop', {
            ...patch, ...own, day: targetDay,
          })
          : detachInstance(draft, 'event', event.id, instanceDay!, {
            ...patch, ...own, repeat: undefined, day: targetDay,
          });
        return;
      }
      // Новый день экземпляра переносит ряд (весь либо его продолжение)
      const series = scope === 'following'
        ? splitSeries(draft, 'event', event.id, instanceDay!, patch) : undefined;
      const seriesId = series?.id || event.id;
      updateSeries(draft, 'event', seriesId, instanceDay!, { ...patch, day: targetDay });
      // Уже отделённые дни ряда (всего либо с этого дня) получают те же изменённые поля
      patchCopies(
        draft, 'event', event.id, changedFields(event, patch), scope === 'following' ? instanceDay : undefined,
      );
      if (ownDescription !== undefined) detachWithDescription(draft, 'event', seriesId, targetDay, ownDescription);
      result = draft.events.find(({ id }) => id === seriesId);
    }, lang('PlannerNoticeEventUpdated', { name: patch.name || event.name }));
    reopen(result, targetDay);
  });

  // Запись правки: `changes` — изменённые поля карточки; правило повтора — только с `repeat`
  const save = useLastCallback((changes: Partial<Values>, nextRepeat?: PlannerRepeat | 'none') => {
    const next = { ...values, ...changes };
    setValues(next);
    const repeat = nextRepeat === undefined ? event.repeat : nextRepeat === 'none' ? undefined : nextRepeat;
    const item = {
      name: next.name.trim(),
      description: next.description.trim() || undefined,
      start: next.isAllDay ? ALL_DAY_START : next.start,
      end: next.isAllDay ? ALL_DAY_END : next.end,
      repeat,
      day: repeat ? undefined : (next.day || undefined),
      isAllDay: next.isAllDay || undefined,
      isHoliday: next.isHoliday || undefined,
      // Цвет — у группы; свой цвет события — только без группы
      color: next.project ? undefined : next.color || undefined,
      project: next.project || undefined,
      remind: next.remind,
    };
    const eventError = validateEvent(item);
    if (eventError) {
      setError(lang(EVENT_ERROR_KEYS[eventError]));
      return;
    }
    setError(undefined);
    if (isInstance) {
      const nextDescription = item.description || '';
      const isDescriptionChanged = nextDescription !== (event.description || '');
      const targetDay = next.day || instanceDay!;
      const hasOtherChanges = item.name !== event.name || item.start !== event.start || item.end !== event.end
        || Boolean(item.isAllDay) !== Boolean(event.isAllDay) || Boolean(item.isHoliday) !== Boolean(event.isHoliday)
        || (item.color || 0) !== (event.color || 0) || targetDay !== instanceDay
        || item.remind !== event.remind || (item.project || '') !== (event.project || '');
      const isOwnDescription = isDescriptionChanged && descriptionScope === 'one';
      const patch: Partial<PlannerEvent> = {
        name: item.name,
        description: isOwnDescription ? event.description : item.description,
        start: item.start,
        end: item.end,
        isAllDay: item.isAllDay,
        isHoliday: item.isHoliday,
        color: item.color,
        project: item.project,
        remind: item.remind,
      };
      const ownDescription = isOwnDescription ? nextDescription : undefined;
      // Новое правило повтора (сравнение — с правилом в том виде, в каком его показывает форма): объём —
      // «это и последующие» или «все в серии», для «Не повторяется» — с какого дня ряда больше нет
      if (nextRepeat !== undefined && !sameRepeat(repeat, draftToRepeat(repeatToDraft(event.repeat)))) {
        setPending({
          kind: 'rule', repeat, patch, ownDescription, targetDay,
        });
        return;
      }
      // Одно описание объёма не спрашивает: его задаёт галочка у поля
      if (isDescriptionChanged && !hasOtherChanges) {
        let saved: PlannerSeriesItem | undefined;
        updatePlanner((draft) => {
          saved = writeDescription(draft, 'event', event, nextDescription, descriptionScope || 'all');
        }, lang('PlannerNoticeEventUpdated', { name: item.name }));
        if (saved && saved.id !== event.id) reopen(saved, instanceDay);
        return;
      }
      if (!hasOtherChanges) return;
      setPending({
        kind: 'save', patch, ownDescription, targetDay,
      });
      return;
    }
    // Отделённый день ряда: правку можно отдать всему ряду; описание — только если галочка «для всех»
    if (!repeat && seriesOfCopy(state, 'event', event)) {
      const fields = changedFields(event, item);
      if (descriptionScope === 'one') delete fields.description;
      if (Object.keys(fields).length) {
        setPending({ kind: 'copy', next: item, fields });
        return;
      }
    }
    if (!Object.keys(changedFields(event, item)).length && sameRepeat(repeat, event.repeat)) return;
    updatePlanner((draft) => {
      saveOwn(draft, item);
    }, lang('PlannerNoticeEventUpdated', { name: item.name }));
  });

  // Правка самой записи (разовой, шаблона ряда либо отделённого дня)
  function saveOwn(draft: PlannerState, next: Partial<PlannerEvent>) {
    const target = draft.events.find(({ id }) => id === event.id);
    if (!target) return undefined;
    Object.assign(target, next);
    if (next.repeat) target.occurrences = undefined;
    // Отделённый день с галочкой «для всех» пишет описание и в свой ряд
    else if (descriptionScope === 'all') writeDescription(draft, 'event', target, next.description || '', 'all');
    return target;
  }

  // Enter в поле названия и «Сохранить» отправляют форму: всё уже записано по месту, остаётся название
  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    save({});
  });

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((current) => ({ ...current, name: e.currentTarget.value }));
  });

  // Значение — из поля: состояние обновится только к следующему кадру
  const handleNameBlur = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const name = e.currentTarget.value;
    if (!name.trim()) {
      setValues((current) => ({ ...current, name: event.name }));
      return;
    }
    if (name.trim() !== event.name) save({ name });
  });

  const handleDescriptionChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValues((current) => ({ ...current, description: e.currentTarget.value }));
  });

  const handleDescriptionBlur = useLastCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    const description = e.currentTarget.value;
    if (description.trim() !== (event.description || '')) save({ description });
  });

  const handleDay = useLastCallback((day: string) => {
    if (day) save({ day });
  });

  // Начало переносит событие целиком: длительность остаётся прежней
  const handleStart = useLastCallback((start: string) => {
    if (!start) return false;
    const span = getSpanMinutes(values.start, values.end) || getSpanMinutes(DEFAULT_START, DEFAULT_END)!;
    const end = getEndByDuration(start, span);
    if (!end) {
      setError(lang('PlannerErrorPastMidnight'));
      return false;
    }
    save({ start, end });
    return undefined;
  });

  const handleDuration = useLastCallback((text: string) => {
    const minutes = parseDuration(text);
    const end = minutes === undefined || Number.isNaN(minutes) ? undefined : getEndByDuration(values.start, minutes);
    if (!end) {
      setError(lang(minutes && minutes > 0 ? 'PlannerErrorPastMidnight' : 'PlannerErrorEventTime'));
      return false;
    }
    save({ end });
    return undefined;
  });

  const handleAllDay = useLastCallback((isAllDay: boolean) => {
    // Событие, бывшее «весь день», получает обычное время
    const isPlaceholderTime = values.start === ALL_DAY_START && values.end === ALL_DAY_END;
    save(isAllDay || !isPlaceholderTime ? { isAllDay } : { isAllDay, start: DEFAULT_START, end: DEFAULT_END });
  });

  const handleHoliday = useLastCallback((isHoliday: boolean) => {
    save({ isHoliday });
  });

  const handleRemind = useLastCallback((remind: number | undefined) => {
    save({ remind });
  });

  const handleProject = useLastCallback((project: string) => {
    save({ project });
  });

  const handleColor = useLastCallback((color: number) => {
    save({ color });
  });

  const handleRepeatSave = useLastCallback(() => {
    const repeat = draftToRepeat(repeatDraft);
    const problem = repeat && validateRepeat(repeat);
    if (problem) {
      setError(lang(REPEAT_ERROR_KEYS[problem]));
      return;
    }
    save({}, repeat || 'none');
  });

  // Шаги пишутся сразу (как у задачи): отметка дня ряда — по дню, новый шаг — всему ряду
  const handleStepToggle = useLastCallback((index: number, isDone: boolean) => {
    updatePlanner((draft) => {
      setEventStepDone(draft, event, index, isDone);
    }, lang('PlannerNoticeStepUpdated', { name: event.steps![index].text }));
  });

  const handleStepAdd = useLastCallback((text: string) => {
    updatePlanner((draft) => {
      const target = draft.events.find(({ id }) => id === event.id);
      if (!target) return;
      target.steps = [...(target.steps || []).map((step) => ({ ...step })), { text, isDone: false }];
    }, lang('PlannerNoticeStepAdded'));
  });

  const handleDelete = useLastCallback(() => {
    if (isInstance) {
      setPending({ kind: 'delete' });
      return;
    }
    updatePlanner((draft) => {
      draft.events = draft.events.filter(({ id }) => id !== event.id);
    }, lang('PlannerNoticeEventDeleted'));
    onBack();
  });

  const handleScope = useLastCallback((scope: PlannerPromptScope) => {
    const action = pending!;
    setPending(undefined);
    applyScope(scope, action);
  });

  // Отказ от правки: поля возвращаются к записи
  const handleCancelPrompt = useLastCallback(() => {
    setPending(undefined);
    // Поля времени держат набранное у себя: с прежним значением записи они не перерисовались бы — новый ключ
    setFieldsRevision((revision) => revision + 1);
    setValues({
      name: event.name,
      description: event.description || '',
      start: event.start,
      end: event.end,
      day: event.instanceDay || event.day || '',
      isAllDay: Boolean(event.isAllDay),
      isHoliday: Boolean(event.isHoliday),
      color: event.color || 0,
      project: event.project || '',
      remind: event.remind,
    });
  });

  // О чём спрашивает выбор объёма: правка полей, удаление, новое правило повтора либо его снятие
  const promptMode = !pending ? undefined
    : pending.kind === 'rule' ? (pending.repeat ? 'rule' : 'stop')
      : pending.kind === 'delete' ? 'delete' : pending.kind === 'copy' ? 'copy' : 'edit';
  const newTime = pending?.kind === 'save' ? getOnlyNewTime(pending.patch, event) : undefined;

  const hasDate = !event.repeat || isInstance;
  const spanMinutes = getSpanMinutes(values.start, values.end);

  // Окно из «Найти свободное время» — сразу день и время события
  const handleFreeSlot = useLastCallback((slotDay: string, slotStart: number, slotEnd: number) => {
    save({ day: slotDay, start: toTime(slotStart), end: toTime(slotEnd) });
  });

  const dayField = hasDate && (
    <PlannerDateField
      label={lang('PlannerFieldDay')}
      value={values.day}
      empty={lang('PlannerUndatedShort')}
      onChange={handleDay}
    />
  );
  const startField = !values.isAllDay && (
    <PlannerField
      key={`start-${fieldsRevision}`}
      label={lang('PlannerFieldStart')}
      type="time"
      value={values.start}
      onCommit={handleStart}
    />
  );
  const durationField = !values.isAllDay && (
    <PlannerField
      key={`duration-${fieldsRevision}`}
      label={lang('PlannerFieldDuration')}
      type="text"
      value={formatDurationValue(lang, spanMinutes)}
      placeholder={lang('PlannerDurationPlaceholder')}
      onCommit={handleDuration}
    />
  );
  const switches = (
    <div className={buildClassName(more.switches, isNarrow && more.switchesRows)}>
      <PvSwitch
        isOn={values.isAllDay}
        className={isNarrow ? more.switchRow : more.switch}
        data-all-day-switch
        onChange={handleAllDay}
      >
        <span>{lang('PlannerAllDay')}</span>
      </PvSwitch>
      <PvSwitch
        isOn={values.isHoliday}
        className={isNarrow ? more.switchRow : more.switch}
        data-holiday-switch
        onChange={handleHoliday}
      >
        <span>{lang('PlannerHoliday')}</span>
      </PvSwitch>
    </div>
  );
  const remindField = <PlannerRemindSelect id="planner-event-remind" value={values.remind} onChange={handleRemind} />;
  const groupField = (
    <>
      <PlannerListPicker id="planner-event-list" state={state} value={values.project} onChange={handleProject} />
      {!values.project && <PlannerColorSwatches value={values.color} onChange={handleColor} />}
    </>
  );
  const repeatRow = (
    <PlannerRepeatRow value={repeatDraft} day={values.day} onChange={setRepeatDraft}>
      <button type="button" className={styles.btn} data-repeat-save onClick={handleRepeatSave}>
        <Icon name="loop" />
        {lang('PlannerRepeatSave')}
      </button>
    </PlannerRepeatRow>
  );
  const steps = <PlannerSteps steps={event.steps || NO_STEPS} onToggle={handleStepToggle} onAdd={handleStepAdd} />;
  const freeTime = hasDate && !values.isAllDay && (
    <PlannerFreeTime
      state={state}
      name={values.name.trim() || event.name}
      minutes={spanMinutes}
      fromDay={values.day || today}
      today={today}
      exceptKey={instanceKey(event)}
      onPick={handleFreeSlot}
    />
  );

  return (
    <form
      id={PLANNER_SIDE_FORM_ID}
      className={buildClassName(styles.editor, styles.eventCard, !isNarrow && more.wide)}
      onSubmit={handleSubmit}
    >
      {!isNarrow && (
        <div className={more.top}>
          <span className={more.topNote} data-event-autosave>{lang('PlannerAutoSaved')}</span>
          <button type="button" className={more.topDelete} onClick={handleDelete}>{lang('PlannerDeleteShort')}</button>
        </div>
      )}
      <input
        id="planner-event-name"
        className={styles.cardTitleInput}
        value={values.name}
        maxLength={NAME_MAX_LENGTH}
        aria-label={lang('PlannerFieldEventName')}
        placeholder={lang('PlannerFieldEventName')}
        onChange={handleNameChange}
        onBlur={handleNameBlur}
      />
      {event.origin && <p className={styles.small}>{lang('PlannerSeriesDetachedHint')}</p>}

      {isNarrow ? (
        <>
          <PlannerCardRow icon="clock" row="when">
            <div className={buildClassName(styles.fields, hasDate && !values.isAllDay && styles.fieldsThree)}>
              {dayField}
              {startField}
              {durationField}
            </div>
            {switches}
          </PlannerCardRow>
          {freeTime && <div className={more.freeTimeRow}>{freeTime}</div>}
          <PlannerCardCaption>{lang('PlannerRepeatAndRemind')}</PlannerCardCaption>
          {repeatRow}
          <PlannerCardRow icon="schedule" row="remind">{remindField}</PlannerCardRow>
          <PlannerCardRow icon="folder" row="group">{groupField}</PlannerCardRow>
          {steps}
        </>
      ) : (
        <>
          <PlannerCardRow icon="clock" row="when">
            <div className={more.grid}>
              {dayField || <span />}
              {startField || <span />}
              {durationField || <span />}
              <div className={more.cell} data-card-row="remind">{remindField}</div>
              <div className={more.cell} data-card-row="group">{groupField}</div>
              <div className={more.cell}>{switches}</div>
            </div>
          </PlannerCardRow>
          {repeatRow}
          <div className={more.columns}>
            {steps}
            {freeTime}
          </div>
        </>
      )}

      <PlannerCardRow icon="info" row="description">
        <TextArea
          id="planner-event-description"
          label={lang('PlannerFieldDescription')}
          placeholder={lang('PlannerOptional')}
          value={values.description}
          maxLength={DESCRIPTION_MAX_LENGTH}
          noReplaceNewlines
          onChange={handleDescriptionChange}
          onBlur={handleDescriptionBlur}
        />
        {descriptionScope && (
          <PlannerDescriptionScope
            scope={descriptionScope}
            shouldConfirmAll={!isInstance}
            onChange={setDescriptionScope}
          />
        )}
      </PlannerCardRow>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {promptMode && (
        <PlannerSeriesPrompt
          mode={promptMode}
          name={event.name}
          rule={event.repeat ? formatRepeatShort(lang, event.repeat) : undefined}
          day={instanceDay}
          newTime={newTime}
          onChoose={handleScope}
          onCancel={handleCancelPrompt}
        />
      )}
      {isNarrow && !promptMode && (
        <button type="button" className={buildClassName(styles.btn, styles.btnDanger)} onClick={handleDelete}>
          <Icon name="delete" />
          {lang('PlannerDeleteRecord')}
        </button>
      )}
    </form>
  );
};

export default memo(PlannerEventEditor);
