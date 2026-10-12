import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerEvent, PlannerEventError, PlannerState } from './plannerModel';
import type { PlannerRepeatDraft } from './PlannerRepeatFields';
import type { PlannerSeriesScope } from './PlannerSeriesPrompt';

import buildClassName from '../../../util/buildClassName';
import { formatRepeat } from './plannerFormat';
import {
  ALL_DAY_END, ALL_DAY_START, detachInstance, excludeInstance, removeSeries, splitSeries, truncateSeries, updateSeries,
  validateEvent,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import PlannerDetailsFold from './PlannerDetailsFold';
import PlannerField from './PlannerField';
import { PlannerColorSwatches } from './PlannerListPicker';
import PlannerName from './PlannerName';
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

type Pending = { kind: 'save'; patch: Partial<PlannerEvent> } | { kind: 'delete' };

// Правка события (spec 011): поля, правило повтора; у экземпляра ряда — выбор объёма правки
const PlannerEventEditor = ({
  state, event, onBack,
}: OwnProps) => {
  const lang = useLang();

  const [name, setName] = useState(event.name);
  const [start, setStart] = useState(event.start);
  const [end, setEnd] = useState(event.end);
  const [day, setDay] = useState(event.instanceDay || event.day || '');
  const [isAllDay, setIsAllDay] = useState(Boolean(event.isAllDay));
  const [isHoliday, setIsHoliday] = useState(Boolean(event.isHoliday));
  const [color, setColor] = useState(event.color || 0);
  const [repeatDraft, setRepeatDraft] = useState<PlannerRepeatDraft>(
    () => repeatToDraft(event.repeat, event.day || ''),
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<Pending>();

  const isInstance = Boolean(event.repeat && event.instanceDay);

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const applyScope = useLastCallback((scope: PlannerSeriesScope, action: Pending) => {
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
    const { patch } = action;
    updatePlanner((draft) => {
      if (scope === 'one') {
        detachInstance(draft, 'event', event.id, instanceDay, { ...patch, repeat: undefined, day: day || instanceDay });
        return;
      }
      // Новый день экземпляра переносит ряд (весь либо его продолжение)
      const seriesId = scope === 'following'
        ? splitSeries(draft, 'event', event.id, instanceDay, patch)?.id || event.id : event.id;
      updateSeries(draft, 'event', seriesId, instanceDay, { ...patch, day: day || instanceDay });
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
      start: isAllDay ? ALL_DAY_START : start,
      end: isAllDay ? ALL_DAY_END : end,
      repeat,
      day: repeat ? undefined : (day || undefined),
      isAllDay: isAllDay || undefined,
      isHoliday: isHoliday || undefined,
      color: color || undefined,
    };
    const eventError = validateEvent(next);
    if (eventError) {
      setError(lang(EVENT_ERROR_KEYS[eventError]));
      return;
    }
    setError(undefined);
    if (isInstance) {
      // Правило повтора у экземпляра не правится — объём правки спрашивается для остальных полей
      setPending({
        kind: 'save',
        patch: {
          name: next.name,
          start: next.start,
          end: next.end,
          isAllDay: next.isAllDay,
          isHoliday: next.isHoliday,
          color: next.color,
        },
      });
      return;
    }
    updatePlanner((draft) => {
      const target = draft.events.find(({ id }) => id === event.id);
      if (!target) return;
      Object.assign(target, next);
      if (repeat) target.occurrences = undefined;
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

  const handleScope = useLastCallback((scope: PlannerSeriesScope) => {
    const action = pending!;
    setPending(undefined);
    applyScope(scope, action);
  });

  const handleCancelPrompt = useLastCallback(() => {
    setPending(undefined);
  });

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
      <PlannerDetailsFold summary={detailsSummary}>
        <div className={styles.checks}>
          <Checkbox label={lang('PlannerAllDay')} checked={isAllDay} onCheck={setIsAllDay} />
          <Checkbox label={lang('PlannerHoliday')} checked={isHoliday} onCheck={setIsHoliday} />
        </div>
        <PlannerColorSwatches value={color} onChange={setColor} />
        {!isInstance && <PlannerRepeatFields value={repeatDraft} onChange={setRepeatDraft} />}
      </PlannerDetailsFold>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {pending ? (
        <PlannerSeriesPrompt
          title={lang(pending.kind === 'delete' ? 'PlannerSeriesDeleteTitle' : 'PlannerSeriesEditTitle')}
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
