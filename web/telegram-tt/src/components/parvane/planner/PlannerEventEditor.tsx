import { memo, useState } from '../../../lib/teact/teact';

import type {
  PlannerEvent, PlannerEventError, PlannerRepeat, PlannerState,
} from './plannerModel';
import type { PlannerRepeatDraft } from './PlannerRepeatFields';
import type { PlannerDescriptionScope as DescriptionScope } from './plannerSeriesEdit';
import type { PlannerPromptScope } from './PlannerSeriesPrompt';

import buildClassName from '../../../util/buildClassName';
import { formatRepeat } from './plannerFormat';
import {
  ALL_DAY_END, ALL_DAY_START, detachInstance, excludeInstance, removeSeries, splitSeries, truncateSeries, updateSeries,
  validateEvent,
} from './plannerModel';
import { detachWithDescription, getDescriptionScope, setDescription as writeDescription } from './plannerSeriesEdit';
import { changeSeriesRule, sameRepeat } from './plannerSeriesRule';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import TextArea from '../../ui/TextArea';
import PlannerDescriptionScope from './PlannerDescriptionScope';
import PlannerDetailsFold from './PlannerDetailsFold';
import PlannerField from './PlannerField';
import { PlannerColorSwatches } from './PlannerListPicker';
import PlannerName from './PlannerName';
import PlannerRemindSelect from './PlannerRemindSelect';
import PlannerRepeatFields, { draftToRepeat, repeatToDraft } from './PlannerRepeatFields';
import PlannerSeriesPrompt from './PlannerSeriesPrompt';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Событие либо экземпляр ряда (`instanceDay`)
  event: PlannerEvent;
  onBack: NoneToVoidFunction;
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
// Движок принимает до 4000 байт: запас на кириллицу
const DESCRIPTION_MAX_LENGTH = 2000;

// `ownDescription` — описание только этого дня: остальные поля правятся в выбранном объёме, день отделяется
// `rule` — вместе с полями меняется правило повтора; без правила — «Не повторяется»
type Pending = { kind: 'save'; patch: Partial<PlannerEvent>; ownDescription?: string }
  | { kind: 'rule'; repeat?: PlannerRepeat; patch: Partial<PlannerEvent>; ownDescription?: string }
  | { kind: 'delete' };

// Правка события (spec 011): поля, правило повтора; у экземпляра ряда — выбор объёма правки
const PlannerEventEditor = ({
  state, event, onBack,
}: OwnProps) => {
  const lang = useLang();

  const [name, setName] = useState(event.name);
  const [description, setDescription] = useState(event.description || '');
  // Чьё описание: всех повторов либо только этого дня; `undefined` — запись не из ряда, галочки нет
  const [descriptionScope, setDescriptionScope] = useState<DescriptionScope | undefined>(
    () => getDescriptionScope(state, 'event', event),
  );
  const [start, setStart] = useState(event.start);
  const [end, setEnd] = useState(event.end);
  const [day, setDay] = useState(event.instanceDay || event.day || '');
  const [isAllDay, setIsAllDay] = useState(Boolean(event.isAllDay));
  const [isHoliday, setIsHoliday] = useState(Boolean(event.isHoliday));
  const [color, setColor] = useState(event.color || 0);
  const [remind, setRemind] = useState(event.remind);
  const [repeatDraft, setRepeatDraft] = useState<PlannerRepeatDraft>(
    () => repeatToDraft(event.repeat, event.day || ''),
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<Pending>();

  const isInstance = Boolean(event.repeat && event.instanceDay);

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const handleDescriptionChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.currentTarget.value);
  });

  const applyScope = useLastCallback((scope: PlannerPromptScope, action: Pending) => {
    const instanceDay = event.instanceDay!;
    if (action.kind === 'delete') {
      updatePlanner((draft) => {
        if (scope === 'one') excludeInstance(draft, 'event', event.id, instanceDay);
        else if (scope === 'following') truncateSeries(draft, 'event', event.id, instanceDay);
        else removeSeries(draft, 'event', event.id);
      }, lang('PlannerNoticeEventDeleted'));
      onBack();
      return;
    }
    const { patch, ownDescription } = action;
    const targetDay = day || instanceDay;
    const own = ownDescription === undefined ? {} : { description: ownDescription || undefined };
    if (action.kind === 'rule') {
      const { repeat } = action;
      updatePlanner((draft) => {
        if (!repeat) {
          // Без повтора: день остаётся разовой записью со всеми правками карточки
          changeSeriesRule(draft, 'event', event.id, instanceDay, undefined, scope === 'stop' ? 'stop' : 'one', {
            ...patch, ...own, day: targetDay,
          });
          return;
        }
        // Дни ряда задаёт новое правило: дата из карточки на него не влияет
        const series = changeSeriesRule(
          draft, 'event', event.id, instanceDay, repeat, scope === 'following' ? 'following' : 'all', patch,
        );
        if (series && ownDescription !== undefined) {
          detachWithDescription(draft, 'event', series.id, instanceDay, ownDescription);
        }
      }, lang(repeat ? 'PlannerNoticeEventUpdated' : 'PlannerNoticeRepeatStopped', { name: patch.name || event.name }));
      onBack();
      return;
    }
    updatePlanner((draft) => {
      if (scope === 'one') {
        detachInstance(draft, 'event', event.id, instanceDay, {
          ...patch, ...own, repeat: undefined, day: targetDay,
        });
        return;
      }
      // Новый день экземпляра переносит ряд (весь либо его продолжение)
      const seriesId = scope === 'following'
        ? splitSeries(draft, 'event', event.id, instanceDay, patch)?.id || event.id : event.id;
      updateSeries(draft, 'event', seriesId, instanceDay, { ...patch, day: targetDay });
      if (ownDescription !== undefined) detachWithDescription(draft, 'event', seriesId, targetDay, ownDescription);
    }, lang('PlannerNoticeEventUpdated', { name: patch.name || event.name }));
    onBack();
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const repeat = draftToRepeat(repeatDraft);
    // Событие, бывшее «весь день», получает обычное время заново
    const wasAllDay = event.isAllDay && !isAllDay && start === ALL_DAY_START && end === ALL_DAY_END;
    if (wasAllDay) {
      setError(lang('PlannerErrorEventTime'));
      return;
    }
    const next = {
      name: name.trim(),
      description: description.trim() || undefined,
      start: isAllDay ? ALL_DAY_START : start,
      end: isAllDay ? ALL_DAY_END : end,
      repeat,
      day: repeat ? undefined : (day || undefined),
      isAllDay: isAllDay || undefined,
      isHoliday: isHoliday || undefined,
      color: color || undefined,
      remind,
    };
    const eventError = validateEvent(next);
    if (eventError) {
      setError(lang(EVENT_ERROR_KEYS[eventError]));
      return;
    }
    setError(undefined);
    if (isInstance) {
      const instanceDay = event.instanceDay!;
      const nextDescription = next.description || '';
      const isDescriptionChanged = nextDescription !== (event.description || '');
      const hasOtherChanges = next.name !== event.name || next.start !== event.start || next.end !== event.end
        || Boolean(next.isAllDay) !== Boolean(event.isAllDay) || Boolean(next.isHoliday) !== Boolean(event.isHoliday)
        || (next.color || 0) !== (event.color || 0) || (day || instanceDay) !== instanceDay
        || next.remind !== event.remind;
      const isOwnDescription = isDescriptionChanged && descriptionScope === 'one';
      const patch = {
        name: next.name,
        ...(isOwnDescription ? undefined : { description: next.description }),
        start: next.start,
        end: next.end,
        isAllDay: next.isAllDay,
        isHoliday: next.isHoliday,
        color: next.color,
        remind: next.remind,
      };
      const ownDescription = isOwnDescription ? nextDescription : undefined;
      // Новое правило повтора (сравнение — с правилом в том виде, в каком его показывает форма): объём —
      // «это и последующие» или «все в серии», для «Не повторяется» — с какого дня ряда больше нет
      if (!sameRepeat(repeat, draftToRepeat(repeatToDraft(event.repeat)))) {
        setPending({
          kind: 'rule', repeat, patch, ownDescription,
        });
        return;
      }
      // Одно описание объёма не спрашивает: его задаёт галочка у поля
      if (isDescriptionChanged && !hasOtherChanges) {
        updatePlanner((draft) => {
          writeDescription(draft, 'event', event, nextDescription, descriptionScope || 'all');
        }, lang('PlannerNoticeEventUpdated', { name: next.name }));
        onBack();
        return;
      }
      setPending({ kind: 'save', patch, ownDescription });
      return;
    }
    updatePlanner((draft) => {
      const target = draft.events.find(({ id }) => id === event.id);
      if (!target) return;
      Object.assign(target, next);
      if (repeat) target.occurrences = undefined;
      // Отделённый день с галочкой «для всех» пишет описание и в свой ряд
      else if (descriptionScope === 'all') writeDescription(draft, 'event', target, next.description || '', 'all');
    }, lang('PlannerNoticeEventUpdated', { name: next.name }));
    onBack();
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

  const handleCancelPrompt = useLastCallback(() => {
    setPending(undefined);
  });

  // О чём спрашивает выбор объёма: правка полей, удаление, новое правило повтора либо его снятие
  const promptMode = !pending ? undefined
    : pending.kind === 'rule' ? (pending.repeat ? 'rule' : 'stop')
      : pending.kind === 'delete' ? 'delete' : 'edit';

  const detailsSummary = [
    event.repeat ? formatRepeat(lang, event.repeat) : undefined,
    isAllDay ? lang('PlannerAllDay') : undefined,
    isHoliday ? lang('PlannerHoliday') : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <form className={styles.editor} onSubmit={handleSubmit}>
      <h2 className={styles.editorTitle}><PlannerName name={event.name} /></h2>
      {event.repeat && (
        <p className={styles.seriesBox}>
          <Icon name="loop" />
          {isInstance
            ? lang('PlannerSeriesInstanceHint', { rule: formatRepeat(lang, event.repeat) })
            : formatRepeat(lang, event.repeat)}
        </p>
      )}
      {event.origin && <p className={styles.small}>{lang('PlannerSeriesDetachedHint')}</p>}
      <InputText
        id="planner-event-name"
        label={lang('PlannerFieldEventName')}
        value={name}
        maxLength={NAME_MAX_LENGTH}
        onChange={handleNameChange}
      />
      <div className={styles.fields}>
        {!isAllDay && <PlannerField label={lang('PlannerFieldStart')} type="time" value={start} onInput={setStart} />}
        {!isAllDay && <PlannerField label={lang('PlannerFieldEnd')} type="time" value={end} onInput={setEnd} />}
        {(!event.repeat || isInstance) && (
          <PlannerField label={lang('PlannerFieldEventDate')} type="date" value={day} onInput={setDay} />
        )}
      </div>
      <TextArea
        id="planner-event-description"
        label={lang('PlannerFieldDescription')}
        value={description}
        maxLength={DESCRIPTION_MAX_LENGTH}
        noReplaceNewlines
        onChange={handleDescriptionChange}
      />
      <PlannerRemindSelect id="planner-event-remind" value={remind} onChange={setRemind} />
      {descriptionScope && (
        <PlannerDescriptionScope
          scope={descriptionScope}
          shouldConfirmAll={!isInstance}
          onChange={setDescriptionScope}
        />
      )}
      <PlannerDetailsFold summary={detailsSummary}>
        <div className={styles.checks}>
          <Checkbox label={lang('PlannerAllDay')} checked={isAllDay} onCheck={setIsAllDay} />
          <Checkbox label={lang('PlannerHoliday')} checked={isHoliday} onCheck={setIsHoliday} />
        </div>
        <PlannerColorSwatches value={color} onChange={setColor} />
        <PlannerRepeatFields value={repeatDraft} onChange={setRepeatDraft} />
      </PlannerDetailsFold>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {promptMode ? (
        <PlannerSeriesPrompt
          mode={promptMode}
          onChoose={handleScope}
          onCancel={handleCancelPrompt}
        />
      ) : (
        <div className={styles.actions}>
          <Button type="submit" size="smaller">{lang('Save')}</Button>
          <button type="button" className={buildClassName(styles.btn, styles.btnDanger)} onClick={handleDelete}>
            <Icon name="delete" />
            {lang('PlannerDeleteEvent')}
          </button>
        </div>
      )}
    </form>
  );
};

export default memo(PlannerEventEditor);
