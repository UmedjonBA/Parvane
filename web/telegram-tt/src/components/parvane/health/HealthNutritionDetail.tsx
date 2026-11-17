import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { HealthNutritionView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  barShares, goalShare, MACRO_KEYS, MACROS, mealTitleKey,
} from './healthDayFormat';
import { formatNumber, WEEKDAY_KEYS } from './healthFormat';
import { shiftDay } from './healthPeriods';
import { loadHealthViewAt, setFoodDayClosed } from './healthStore';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSheet from '../notes/PvSheet';
import HealthGoalInput from './HealthGoalInput';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  // Питание сегодняшнего дня; прошлый день экран запрашивает у движка сам
  nutrition: HealthNutritionView;
  // Заготовка строки ввода: «ужин »
  onExample: (text: string) => void;
};

// Parvane (spec 041 B3; доски `XdHealth`, `ZpHealthX`, `PhModSettings`): питание за день — калории и БЖУ против
// целей, приёмы пищи, закрытие дня и калории за неделю. Все числа — из движка (`healthView.nutrition`); прошлый
// день — та же сводка на конец того дня
const HealthNutritionDetail = ({ nutrition: todayNutrition, onExample }: OwnProps) => {
  const today = todayNutrition.day;
  const { lang, dayTitle } = useHealthLabels(today);
  const [isClosing, setIsClosing] = useState(false);
  const [pastDay, setPastDay] = useState<string>();
  const [past, setPast] = useState<HealthNutritionView>();
  // Данные сменились (запись, закрытие дня) — прошлый день перечитывается
  useEffect(() => {
    if (!pastDay) return undefined;
    let isStale = false;
    void loadHealthViewAt(pastDay).then((view) => {
      if (view && !isStale) setPast(view.nutrition);
    });
    return () => {
      isStale = true;
    };
  }, [pastDay, todayNutrition]);
  const isPast = Boolean(pastDay) && past?.day === pastDay;
  const nutrition = isPast ? past : todayNutrition;

  const handlePrevDay = useLastCallback(() => setPastDay(shiftDay(pastDay || today, -1)));
  const handleNextDay = useLastCallback(() => {
    const next = shiftDay(pastDay!, 1);
    setPastDay(next >= today ? undefined : next);
  });
  const {
    total, goals, meals, week, weekAvg, left, day, closed: isClosed,
  } = nutrition;
  const number = (value: number) => formatNumber(value, lang.code);
  const missing = meals.filter((meal) => !meal.entries.length);

  const handleAdd = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onExample(`${e.currentTarget.dataset.title!.toLowerCase()} `);
  });
  const handleAskClose = useLastCallback(() => setIsClosing(true));
  const handleCancelClose = useLastCallback(() => setIsClosing(false));
  const handleClose = useLastCallback(() => {
    setIsClosing(false);
    void setFoodDayClosed(day, true);
  });
  const handleReopen = useLastCallback(() => {
    void setFoodDayClosed(day, false);
  });

  const shares = barShares(week.map((item) => item.kcal), goals.kcal);

  return (
    <>
      <div className={styles.dayNav} data-health-day={nutrition.day}>
        <button type="button" className={kit.ib} aria-label={lang('HealthDayPrev')} onClick={handlePrevDay}>
          <ParvaneIcon name="left" isSmall />
        </button>
        <span className={kit.grow}>{dayTitle(pastDay || today)}</span>
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('HealthDayNext')}
          disabled={!pastDay}
          onClick={handleNextDay}
        >
          <ParvaneIcon name="right" isSmall />
        </button>
      </div>
      <section className={buildClassName(kit.card, styles.card)} data-health-card="food">
        {MACROS.map((macro) => {
          const goal = goals[macro];
          const unit = macro === 'kcal' ? '' : ` ${lang('HealthUnitGram')}`;
          return (
            <div key={macro} className={styles.macroRow} data-health-macro={macro}>
              <span className={kit.grow}>{lang(MACRO_KEYS[macro])}</span>
              <span className={kit.mono} data-health-value>
                {goal !== undefined ? `${number(total[macro])} / ${number(goal)}` : number(total[macro])}
                {unit}
              </span>
              <span className={buildClassName(styles.waterTrack, styles.macroTrack)} aria-hidden>
                <span className={styles.dayFill} style={`width: ${goalShare(total[macro], goal) * 100}%`} />
              </span>
            </div>
          );
        })}
      </section>
      <section className={buildClassName(kit.card, styles.card)}>
        <div className={kit.caps}>{lang('HealthMealsTitle')}</div>
        {meals.map((meal) => {
          const title = lang(mealTitleKey(meal.meal));
          const isEmpty = !meal.entries.length;
          return (
            <div key={meal.meal} className={styles.mealRow} data-health-meal={meal.meal}>
              <span className={styles.mealTitle}>{title}</span>
              <span className={buildClassName(kit.muted, kit.grow, styles.mealNames)}>
                {isEmpty ? lang('HealthMealEmpty') : meal.names}
              </span>
              {isEmpty && isPast ? undefined : isEmpty ? (
                <button type="button" className={kit.btn} data-title={title} onClick={handleAdd}>
                  {lang('HealthMealAdd')}
                </button>
              ) : (
                <>
                  <span className={buildClassName(kit.muted, kit.mono, kit.small)}>
                    {lang('HealthMacrosShort', {
                      protein: number(meal.protein), fat: number(meal.fat), carbs: number(meal.carbs),
                    })}
                  </span>
                  <span className={buildClassName(kit.mono, styles.mealKcal)} data-health-value>
                    {number(meal.kcal)}
                  </span>
                </>
              )}
            </div>
          );
        })}
        {isClosed ? (
          <div className={styles.cardButtons}>
            <span className={buildClassName(kit.muted, kit.grow)} data-health-day-closed>
              {lang('HealthDayClosed')}
            </span>
            <button type="button" className={kit.btn} data-health-action="reopen-day" onClick={handleReopen}>
              {lang('HealthDayReopen')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={buildClassName(kit.btn, styles.more)}
            data-health-action="close-day"
            onClick={handleAskClose}
          >
            {lang('HealthDayClose')}
          </button>
        )}
      </section>
      <section className={buildClassName(kit.card, styles.card)}>
        <div className={styles.cardHead}>
          <span className={buildClassName(kit.caps, kit.grow)}>{lang('HealthKcalWeekTitle')}</span>
          {weekAvg !== undefined && (
            <span className={buildClassName(kit.muted, kit.small)} data-health-week-avg>
              {goals.kcal !== undefined
                ? lang('HealthKcalWeekAvgGoal', { avg: number(weekAvg), goal: number(goals.kcal) })
                : lang('HealthKcalWeekAvg', { avg: number(weekAvg) })}
            </span>
          )}
        </div>
        <div className={styles.bars} role="img" aria-label={lang('HealthKcalWeekTitle')}>
          {week.map((item, index) => (
            <span key={item.day} className={styles.barColumn} data-day={item.day}>
              <span className={styles.barTrack}>
                <span
                  className={buildClassName(styles.bar, item.full && styles.barFull)}
                  style={`height: ${shares[index] * 100}%`}
                />
              </span>
              <span className={buildClassName(kit.mono, styles.barLabel)}>{lang(WEEKDAY_KEYS[item.weekday])}</span>
            </span>
          ))}
        </div>
      </section>
      <section className={buildClassName(kit.card, styles.card)}>
        <div className={kit.caps}>{lang('HealthNutritionGoals')}</div>
        {MACROS.map((macro) => (
          <HealthGoalInput
            key={macro}
            id={macro}
            label={lang(MACRO_KEYS[macro])}
            value={goals[macro]}
            unit={lang(macro === 'kcal' ? 'HealthUnitKcal' : 'HealthUnitGram')}
          />
        ))}
      </section>
      <PvSheet
        isOpen={isClosing}
        title={lang('HealthDayCloseQuestion')}
        onClose={handleCancelClose}
        onEnter={handleClose}
      >
        <div className={styles.fields} data-health-sheet="close-day">
          <div className={kit.muted}>{lang('HealthDayCloseHint')}</div>
          <div className={styles.macroRow}>
            <span className={kit.grow}>{lang('HealthDayLogged')}</span>
            <span className={kit.mono}>{lang('HealthKcalValue', { value: number(total.kcal) })}</span>
          </div>
          {goals.kcal !== undefined && left !== undefined && (
            <>
              <div className={styles.macroRow}>
                <span className={kit.grow}>{lang('HealthDayGoal')}</span>
                <span className={kit.mono}>{lang('HealthKcalValue', { value: number(goals.kcal) })}</span>
              </div>
              <div className={styles.macroRow} data-health-day-delta>
                <span className={kit.grow}>{lang(left >= 0 ? 'HealthDayUnder' : 'HealthDayOver')}</span>
                <span className={kit.mono}>{lang('HealthKcalValue', { value: number(Math.abs(left)) })}</span>
              </div>
            </>
          )}
          {missing.map((meal) => (
            <div key={meal.meal} className={styles.macroRow}>
              <span className={kit.grow}>{lang(mealTitleKey(meal.meal))}</span>
              <span className={kit.muted}>{lang('HealthMealEmpty')}</span>
            </div>
          ))}
          <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthDayReopenHint')}</div>
        </div>
        <div className={kit.sheetButtons}>
          <span className={kit.grow} />
          <button type="button" className={kit.btn} onClick={handleCancelClose}>{lang('HealthDayCloseCancel')}</button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            data-health-action="confirm-close-day"
            onClick={handleClose}
          >
            {lang('HealthDayCloseConfirm')}
          </button>
        </div>
      </PvSheet>
    </>
  );
};

export default memo(HealthNutritionDetail);
