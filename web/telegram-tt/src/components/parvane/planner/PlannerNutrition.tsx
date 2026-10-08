import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { LangFn } from '../../../util/localization';
import type {
  PlannerFoodEntry, PlannerMeal, PlannerMetric, PlannerNutrient, PlannerState,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatNumber } from './plannerFormat';
import {
  getNutrientGoal, getNutrientStatus, getNutrientTotal, isKnownNumber, makeFoodEntry, PLANNER_MEALS,
  PLANNER_METRICS, PLANNER_NUTRIENTS,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import Select from '../../ui/Select';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  // Счётчик запросов «+ Запись» из шапки планировщика
  addRequest: number;
};

const METRIC_KEYS = {
  kcal: 'PlannerMetricKcal',
  protein: 'PlannerMetricProtein',
  fat: 'PlannerMetricFat',
  carbs: 'PlannerMetricCarbs',
  fiber: 'PlannerMetricFiber',
} as const satisfies Record<PlannerNutrient, string>;

const SHORT_KEYS = {
  protein: 'PlannerMetricProteinShort',
  fat: 'PlannerMetricFatShort',
  carbs: 'PlannerMetricCarbsShort',
} as const;

const MEAL_KEYS = {
  breakfast: 'PlannerMealBreakfast',
  lunch: 'PlannerMealLunch',
  dinner: 'PlannerMealDinner',
  snack: 'PlannerMealSnack',
  other: 'PlannerMealOther',
} as const satisfies Record<PlannerMeal, string>;

const STATUS_KEYS = {
  none: 'PlannerFoodStatusNone',
  incomplete: 'PlannerFoodStatusIncomplete',
  open: 'PlannerFoodStatusOpen',
  below: 'PlannerFoodStatusBelow',
  above: 'PlannerFoodStatusAbove',
  ok: 'PlannerFoodStatusOk',
} as const;

const FOOD_NAME_MAX_LENGTH = 100;
const EMPTY_VALUES: Record<PlannerNutrient | 'grams', string> = {
  kcal: '', protein: '', fat: '', carbs: '', fiber: '', grams: '100',
};

export function formatMetric(lang: LangFn, metric: PlannerNutrient) {
  return lang(METRIC_KEYS[metric]);
}

export function formatMetricUnit(lang: LangFn, metric: PlannerNutrient) {
  return lang(metric === 'kcal' ? 'PlannerUnitKcal' : 'PlannerUnitGram');
}

export function formatFoodStatus(lang: LangFn, state: PlannerState, day: string, metric: PlannerMetric = 'kcal') {
  return lang(STATUS_KEYS[getNutrientStatus(state, day, metric)]);
}

// Дневник питания дня: прогресс по калориям и БЖУ, записи по приёмам пищи, вода
const PlannerNutrition = ({
  state, day, today, addRequest,
}: OwnProps) => {
  const lang = useLang();

  const [editedIndex, setEditedIndex] = useState<number>();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [meal, setMeal] = useState<PlannerMeal>('breakfast');
  const [isPer100, setIsPer100] = useState(false);
  const [values, setValues] = useState(EMPTY_VALUES);
  const [error, setError] = useState<string>();

  const record = state.nutrition[day] || { entries: [], isComplete: false };
  const isFuture = day > today;

  const openForm = useLastCallback((index?: number) => {
    const entry = index === undefined ? undefined : record.entries[index];
    const base = entry?.per100 || entry;
    setEditedIndex(index);
    setName(entry?.name || '');
    setMeal(entry?.meal || 'breakfast');
    setIsPer100(Boolean(entry?.per100));
    setValues({
      kcal: toInput(base?.kcal),
      protein: toInput(base?.protein),
      fat: toInput(base?.fat),
      carbs: toInput(base?.carbs),
      fiber: toInput(base?.fiber),
      grams: toInput(entry?.grams) || '100',
    });
    setError(undefined);
    setIsFormOpen(true);
  });

  const closeForm = useLastCallback(() => {
    setIsFormOpen(false);
    setEditedIndex(undefined);
  });

  // Другой день либо «+ Запись» из шапки
  useEffect(closeForm, [day, closeForm]);
  useEffect(() => {
    if (addRequest && !isFuture) openForm();
  }, [addRequest, isFuture, openForm]);

  const handleEntryClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openForm(Number(e.currentTarget.dataset.index));
  });

  const handleAddClick = useLastCallback(() => {
    openForm();
  });

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const handleMealChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setMeal(e.currentTarget.value as PlannerMeal);
  });

  // Обновление от прежнего состояния: два поля, заполненные между отрисовками
  // (быстрый ввод, автозаполнение), иначе затирали друг друга — калории
  // «пустые» при видимом значении (плавающий шаг питания в e2e, 8 окт 2026)
  const setValue = useLastCallback((key: PlannerNutrient | 'grams', value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }));
  });

  const changeDay = useLastCallback((mutate: (target: typeof record) => void, notice: string) => {
    updatePlanner((draft) => {
      draft.nutrition[day] ??= { entries: [], isComplete: false };
      mutate(draft.nutrition[day]);
    }, notice);
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return setError(lang('PlannerErrorName'));
    const parsed: Partial<Record<PlannerNutrient, number>> = {};
    for (const nutrient of PLANNER_NUTRIENTS) {
      const raw = values[nutrient];
      const value = raw === '' ? undefined : Number(raw);
      if ((nutrient === 'kcal' && raw === '') || (raw !== '' && !isKnownNumber(value))) {
        return setError(lang('PlannerErrorNutrient', { name: formatMetric(lang, nutrient) }));
      }
      parsed[nutrient] = value;
    }
    const grams = Number(values.grams);
    if (isPer100 && (!isKnownNumber(grams) || grams <= 0)) return setError(lang('PlannerErrorGrams'));

    const entry = makeFoodEntry({
      id: editedIndex === undefined ? undefined : record.entries[editedIndex]?.id,
      name, meal, isPer100, grams, values: parsed,
    });
    const index = editedIndex;
    changeDay((target) => {
      if (index === undefined) target.entries.push(entry);
      else target.entries[index] = entry;
      target.isComplete = false;
    }, lang(index === undefined ? 'PlannerNoticeFoodAdded' : 'PlannerNoticeFoodUpdated'));
    return closeForm();
  });

  const handleDelete = useLastCallback(() => {
    const index = editedIndex!;
    changeDay((target) => {
      target.entries.splice(index, 1);
      target.isComplete = false;
    }, lang('PlannerNoticeFoodDeleted'));
    closeForm();
  });

  const handleWater = useLastCallback((value: string) => {
    const waterMl = value === '' ? undefined : Number(value);
    if (waterMl !== undefined && !isKnownNumber(waterMl)) return setError(lang('PlannerErrorWater'));
    return changeDay((target) => {
      target.waterMl = waterMl;
      target.isComplete = false;
    }, lang('PlannerNoticeWaterUpdated'));
  });

  const handleComplete = useLastCallback((isComplete: boolean) => {
    if (isFuture || !record.entries.length) return setError(lang('PlannerErrorCompleteEmpty'));
    setError(undefined);
    return changeDay((target) => {
      target.isComplete = isComplete;
      if (isComplete) {
        target.goal = { ...state.calorieGoal };
        target.macroGoals = structuredClone(state.macroGoals);
      }
    }, lang(isComplete ? 'PlannerNoticeFoodDayClosed' : 'PlannerNoticeFoodDayOpened'));
  });

  const hasMissingMacros = PLANNER_METRICS.slice(1).some((metric) => getNutrientTotal(state, day, metric).missing);
  const fiber = getNutrientTotal(state, day, 'fiber');

  return (
    <div className={styles.dayList}>
      <div className={styles.nutrients}>
        {PLANNER_METRICS.map((metric) => {
          const total = getNutrientTotal(state, day, metric);
          const goal = getNutrientGoal(state, day, metric);
          const shown = total.count ? `${formatNumber(lang, total.value)}${total.missing ? ' + ?' : ''}` : '—';
          return (
            <div key={metric} className={styles.nutrient}>
              <div className={styles.nutrientHead}>
                <span>{formatMetric(lang, metric)}</span>
                <span>
                  {shown}
                  <small className={styles.small}>
                    {` / ${formatNumber(lang, goal.target)} ${formatMetricUnit(lang, metric)}`}
                  </small>
                </span>
              </div>
              <div
                className={styles.track}
                style={`--planner-progress: ${Math.min(100, (total.value / goal.target) * 100)}%`}
                aria-hidden="true"
              >
                <span />
              </div>
            </div>
          );
        })}
      </div>
      {hasMissingMacros && <p className={styles.small}>{lang('PlannerFoodMissingNote')}</p>}
      {!record.entries.length && (
        <p className={styles.small}>{lang(isFuture ? 'PlannerFoodFutureDay' : 'PlannerFoodEmpty')}</p>
      )}
      {PLANNER_MEALS.map((mealKey) => {
        const entries = record.entries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.meal === mealKey);
        if (!entries.length) return undefined;
        const mealKcal = entries.reduce((sum, { entry }) => sum + entry.kcal, 0);
        return (
          <div key={mealKey}>
            <h3 className={buildClassName(styles.group, styles.mealHead)}>
              <span>{lang(MEAL_KEYS[mealKey])}</span>
              <span>{`${formatNumber(lang, mealKcal)} ${lang('PlannerUnitKcal')}`}</span>
            </h3>
            {entries.map(({ entry, index }) => (
              <button
                key={`${index}${entry.name}`}
                type="button"
                className={styles.mealEntry}
                data-index={index}
                aria-label={lang('PlannerAriaEditFood', { name: entry.name })}
                onClick={handleEntryClick}
              >
                <span className={styles.mealEntryTop}>
                  <span className={styles.taskName}>{entry.name}</span>
                  <span>{`${formatNumber(lang, entry.kcal)} ${lang('PlannerUnitKcal')}`}</span>
                </span>
                <span className={styles.small}>{formatMacros(entry)}</span>
              </button>
            ))}
          </div>
        );
      })}
      {!isFormOpen && (
        <Button isText size="smaller" className={styles.inlineAdd} disabled={isFuture} onClick={handleAddClick}>
          {lang('PlannerFoodAdd')}
        </Button>
      )}
      {isFormOpen && (
        <form className={styles.form} onSubmit={handleSubmit}>
          <h3 className={styles.group}>
            {lang(editedIndex === undefined ? 'PlannerFoodAddTitle' : 'PlannerFoodEditTitle')}
          </h3>
          <InputText
            id="planner-food-name"
            label={lang('PlannerFoodName')}
            value={name}
            maxLength={FOOD_NAME_MAX_LENGTH}
            autoFocus
            onChange={handleNameChange}
          />
          <Select label={lang('PlannerFoodMeal')} value={meal} hasArrow onChange={handleMealChange}>
            {PLANNER_MEALS.map((item) => <option key={item} value={item}>{lang(MEAL_KEYS[item])}</option>)}
          </Select>
          <Checkbox label={lang('PlannerFoodPer100')} checked={isPer100} onCheck={setIsPer100} />
          <p className={styles.small}>{lang(isPer100 ? 'PlannerFoodPer100Hint' : 'PlannerFoodPortionHint')}</p>
          {isPer100 && renderNumber('grams', lang('PlannerFoodGrams'))}
          <div className={styles.fields}>
            {PLANNER_NUTRIENTS.map((nutrient) => renderNumber(
              nutrient, `${formatMetric(lang, nutrient)}, ${formatMetricUnit(lang, nutrient)}`,
            ))}
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.actions}>
            <Button type="submit" size="smaller">{lang(editedIndex === undefined ? 'PlannerAdd' : 'Save')}</Button>
            <Button isText size="smaller" onClick={closeForm}>{lang('Cancel')}</Button>
            {editedIndex !== undefined && (
              <Button isText size="smaller" color="danger" onClick={handleDelete}>{lang('Delete')}</Button>
            )}
          </div>
        </form>
      )}
      <details className={styles.fold}>
        <summary>{lang('PlannerFoodExtra')}</summary>
        <p className={styles.small}>
          {fiber.count
            ? lang('PlannerFoodFiberValue', {
              value: `${formatNumber(lang, fiber.value)}${fiber.missing ? ' + ?' : ''}`,
            })
            : lang('PlannerFoodFiberNone')}
        </p>
        <PlannerField
          label={lang('PlannerFoodWater')}
          type="number"
          value={toInput(record.waterMl)}
          min={0}
          step="any"
          disabled={isFuture}
          onCommit={handleWater}
        />
      </details>
      <Checkbox
        label={lang('PlannerFoodDayComplete')}
        checked={record.isComplete}
        disabled={isFuture}
        onCheck={handleComplete}
      />
      {!isFormOpen && error && <p className={styles.error} role="alert">{error}</p>}
      {record.isComplete && (
        <p className={styles.small}>
          {lang('PlannerFoodDayResult', { status: formatFoodStatus(lang, state, day) })}
        </p>
      )}
    </div>
  );

  function renderNumber(key: PlannerNutrient | 'grams', label: string) {
    return (
      <PlannerField
        key={key}
        label={label}
        type="number"
        value={values[key]}
        min={0}
        step="any"
        placeholder={key === 'kcal' ? lang('PlannerFoodRequired') : undefined}
        onInput={(value) => setValue(key, value)}
      />
    );
  }

  function formatMacros(entry: PlannerFoodEntry) {
    const parts = (['protein', 'fat', 'carbs'] as const).map((metric) => {
      const value = entry[metric];
      return `${lang(SHORT_KEYS[metric])} ${isKnownNumber(value) ? formatNumber(lang, value) : '?'}`;
    });
    if (entry.grams) parts.push(`${formatNumber(lang, entry.grams)} ${lang('PlannerUnitGram')}`);
    return parts.join(' · ');
  }
};

function toInput(value?: number) {
  return isKnownNumber(value) ? String(value) : '';
}

export default memo(PlannerNutrition);
