import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerMeal, PlannerNutrient, PlannerState } from './plannerModel';

import { formatDay } from './plannerFormat';
import {
  isKnownNumber, makeFoodEntry, PLANNER_MEALS, PLANNER_NUTRIENTS,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import Select from '../../ui/Select';
import PlannerField from './PlannerField';
import { formatMetric, formatMetricUnit, MEAL_KEYS } from './PlannerNutrition';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  // Правка записи с этим id; нет — новая запись
  entryId?: string;
  onClose: NoneToVoidFunction;
};

const FOOD_NAME_MAX_LENGTH = 100;

function toInput(value?: number) {
  return value === undefined ? '' : String(value);
}

// Запись питания: блюдо, приём пищи, калории и БЖУ (на порцию либо на 100 г). Открывается левой
// колонкой «Плана» — дневник дня остаётся виден справа
const PlannerFoodForm = ({
  state, day, today, entryId, onClose,
}: OwnProps) => {
  const lang = useLang();

  const entry = entryId === undefined ? undefined : state.nutrition[day]?.entries.find(({ id }) => id === entryId);
  const base = entry?.per100 || entry;

  const [name, setName] = useState(entry?.name || '');
  const [meal, setMeal] = useState<PlannerMeal>(entry?.meal || 'breakfast');
  const [isPer100, setIsPer100] = useState(Boolean(entry?.per100));
  const [values, setValues] = useState<Record<PlannerNutrient | 'grams', string>>(() => ({
    kcal: toInput(base?.kcal),
    protein: toInput(base?.protein),
    fat: toInput(base?.fat),
    carbs: toInput(base?.carbs),
    fiber: toInput(base?.fiber),
    grams: toInput(entry?.grams) || '100',
  }));
  const [error, setError] = useState<string>();

  const isPast = day < today;

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const handleMealChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setMeal(e.currentTarget.value as PlannerMeal);
  });

  // Обновление от прежнего состояния: два поля, заполненные между отрисовками, не затирают друг друга
  const setValue = useLastCallback((key: PlannerNutrient | 'grams', value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }));
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

    const next = makeFoodEntry({
      id: entry?.id, name, meal, isPer100, grams, values: parsed,
    });
    updatePlanner((draft) => {
      draft.nutrition[day] ??= { entries: [], isComplete: false };
      const target = draft.nutrition[day];
      const index = entry ? target.entries.findIndex(({ id }) => id === entry.id) : -1;
      if (index >= 0) target.entries[index] = next;
      else target.entries.push(next);
      // Прошедший день завершён сам — правка записи отметку не снимает
      if (!isPast) target.isComplete = false;
    }, lang(entry ? 'PlannerNoticeFoodUpdated' : 'PlannerNoticeFoodAdded'));
    return onClose();
  });

  const handleDelete = useLastCallback(() => {
    updatePlanner((draft) => {
      const target = draft.nutrition[day];
      if (!target) return;
      target.entries = target.entries.filter(({ id }) => id !== entry!.id);
      if (!isPast) target.isComplete = false;
    }, lang('PlannerNoticeFoodDeleted'));
    onClose();
  });

  return (
    <form className={styles.form} data-food-form={day} onSubmit={handleSubmit}>
      <p className={styles.small}>{formatDay(lang, day)}</p>
      <InputText
        id="planner-food-name"
        label={lang('PlannerFoodName')}
        value={name}
        maxLength={FOOD_NAME_MAX_LENGTH}
        autoFocus
        onChange={handleNameChange}
      />
      <Select
        id="planner-food-meal"
        label={lang('PlannerFoodMeal')}
        value={meal}
        hasArrow
        onChange={handleMealChange}
      >
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
        <Button type="submit" size="smaller">{lang(entry ? 'Save' : 'PlannerAdd')}</Button>
        <Button isText size="smaller" onClick={onClose}>{lang('Cancel')}</Button>
        {entry && <Button isText size="smaller" color="danger" onClick={handleDelete}>{lang('Delete')}</Button>}
      </div>
    </form>
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
};

export default memo(PlannerFoodForm);
