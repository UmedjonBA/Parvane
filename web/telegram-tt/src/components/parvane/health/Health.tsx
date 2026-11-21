import {
  memo, useEffect, useLayoutEffect, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { HealthSheetTarget } from './HealthEntrySheet';
import type { HealthGoalTarget } from './HealthGoalSheet';
import type { HealthPeriod } from './healthPeriods';
import type { HealthDraft, HealthEntry } from './healthTypes';
import { LeftColumnContent, SettingsScreens } from '../../../types';

import buildClassName from '../../../util/buildClassName';
import { openHealthQuick } from '../../../util/parvaneQuick';
import {
  consumeHealthAddRequest, getHealthAddRequest, getIsParvaneScreenShown, getParvaneSection, setParvaneSection,
} from '../../../util/parvaneSection';
import { formatDate } from '../planner/plannerFormat';
import { FOOD_KIND, WORKOUT_KIND } from './healthDayFormat';
import {
  BLOCK_KINDS, kindTitleKey, MOOD_KIND, orderMetrics, WATER_KIND,
} from './healthFormat';
import { PERIOD_KEYS, PERIODS } from './healthPeriods';
import {
  addHealthEntries, getHealthState, retryHealth, watchHealth,
} from './healthStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';
import useWindowSize from '../../../hooks/window/useWindowSize';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvLoading from '../notes/PvLoading';
import PvOfflineBar from '../notes/PvOfflineBar';
import HealthDetail from './HealthDetail';
import HealthEntrySheet from './HealthEntrySheet';
import HealthFirst from './HealthFirst';
import HealthGoalSheet from './HealthGoalSheet';
import HealthQuickInput from './HealthQuickInput';
import HealthQuickSheet from './HealthQuickSheet';
import HealthSideNav from './HealthSideNav';
import HealthSummary from './HealthSummary';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

// Первое открытие закрыто кнопкой «Готово» — на этом устройстве
const FIRST_DONE_KEY = 'parvane:health-first-done';
// Телефон: шапка без строки ввода, запись — кнопкой «+» (доска `Health`); до 925 px — раскладка телефона
const PHONE_WIDTH = 600;
const NARROW_WIDTH = 925;
const DATE_FORMAT = { weekday: 'long', day: 'numeric', month: 'long' } as const;
const MONTH_FORMAT = { month: 'long' } as const;
const STATUS_KEYS = {
  'needs-linking': 'HealthStatusNeedsLinking',
  'no-key': 'HealthStatusNoKey',
  offline: 'HealthStatusOffline',
  loading: 'HealthStatusLoading',
} as const;
// Экраны без выбора периода
const NO_PERIOD_KINDS = [MOOD_KIND, FOOD_KIND, WORKOUT_KIND];

// Parvane (spec 038, 041): модуль «Здоровье» — сводка, запись одной строкой и подробные экраны. На компьютере у
// подробного экрана слева колонка показателей с «‹ Сводка» (доска `DeskHealthDetail`), в шапке — название и период.
// Данные — контейнер домена `parvane.health.v1`; числа и разбор ввода — из движка. Какие блоки показывать, решает
// экран «Профиль → Модули» этого устройства
const Health = () => {
  const { openLeftColumnContent, openSettingsScreen } = getActions();

  const lang = useLang();
  const section = useDerivedState(getParvaneSection);
  const state = useDerivedState(getHealthState);
  const request = useDerivedState(getHealthAddRequest);
  const { prefs } = useParvaneModules();
  const { width } = useWindowSize();
  const [detailKind, setDetailKind] = useState<string>();
  const [period, setPeriod] = useState<HealthPeriod>('week');
  const [example, setExample] = useState<{ text?: string }>();
  const [sheetTarget, setSheetTarget] = useState<HealthSheetTarget>();
  const [goalTarget, setGoalTarget] = useState<HealthGoalTarget>();
  const [isFirstDone, setIsFirstDone] = useState(readIsFirstDone);
  const isPhone = width <= PHONE_WIDTH;
  const isWide = width > NARROW_WIDTH;

  const isShown = section === 'health';
  useEffect(() => {
    watchHealth(isShown);
  }, [isShown]);

  const { view, status } = state;
  const blocks = prefs.healthBlocks;
  const hiddenKinds = Object.entries(BLOCK_KINDS)
    .filter(([block]) => !blocks.includes(block as typeof blocks[number]))
    .flatMap(([, kinds]) => kinds);
  const isEmpty = Boolean(view) && !view.recent.length && !view.metrics.length;
  // Первое открытие — отдельным экраном вместо сводки (доски `ZpHealthX`, `ZdHealthX`); строка ввода — в нём
  const isFirst = isEmpty && !isFirstDone && !detailKind;
  // Запрос «записать показатель» забирает показанный модуль (скрытый после первого показа остаётся смонтированным)
  const pending = getIsParvaneScreenShown('health') ? request : undefined;
  // «+» и команды общего поиска открывают шторку «Запись в здоровье» (доска `PlusModes`); на первом открытии
  // строка ввода — на самом экране
  const isQuickInSheet = !isFirst;

  useLayoutEffect(() => {
    if (!pending || !isQuickInSheet) return;
    consumeHealthAddRequest();
    openHealthQuick(pending.text);
  }, [pending, isQuickInSheet]);

  const addMark = useLastCallback((kind: 'sleep_start' | 'sleep_end') => {
    const entry: HealthDraft = {
      kind,
      atMs: Date.now(),
      endMs: 0,
      tzMin: -new Date().getTimezoneOffset(),
      value: 0,
      value2: 0,
      unit: '',
      source: 'button',
    };
    void addHealthEntries([entry]);
  });
  const handleBed = useLastCallback(() => addMark('sleep_start'));
  const handleWake = useLastCallback(() => addMark('sleep_end'));

  const handleOpen = useLastCallback((kind: string) => setDetailKind(kind));
  const handleBack = useLastCallback(() => setDetailKind(undefined));

  const handleOpenBlocks = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
    openSettingsScreen({ screen: SettingsScreens.ParvaneModules });
  });

  const handleExample = useLastCallback((text: string) => setExample({ text }));

  const handleFirstDone = useLastCallback(() => {
    setIsFirstDone(true);
    try {
      localStorage.setItem(FIRST_DONE_KEY, '1');
    } catch {
      // Подсказка вернётся после перезагрузки
    }
  });

  const handlePeriod = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPeriod(e.currentTarget.dataset.healthPeriod as HealthPeriod);
  });

  const handleEdit = useLastCallback((entry: HealthEntry) => setSheetTarget({ entry }));
  const handleNap = useLastCallback(() => setSheetTarget({ napDay: view!.today }));
  const handleNapOn = useLastCallback((day: string) => setSheetTarget({ napDay: day }));
  const handleSheetClose = useLastCallback(() => setSheetTarget(undefined));
  const handleGoalClose = useLastCallback(() => setGoalTarget(undefined));
  const handleQuickEdit = useLastCallback((entry: HealthEntry) => setSheetTarget({ entry, isNew: true }));

  const handleRequestHandled = useLastCallback(() => {
    if (request && !isQuickInSheet) consumeHealthAddRequest();
    setExample(undefined);
  });

  const quickRequest = (isQuickInSheet ? undefined : pending) || example;

  function renderTitle(kind: string) {
    if (kind === FOOD_KIND || (kind === WATER_KIND && blocks.includes('food'))) {
      return lang(blocks.includes('water') ? 'HealthNutritionTitle' : 'ParvaneHealthBlockFood');
    }
    if (kind === WORKOUT_KIND) return lang('HealthActivityTitle');
    if (kind === 'pressure') return lang('HealthPressureTitle');
    if (kind === 'steps' && isWide) return lang('HealthStepsTitle');
    if (kind === 'sleep') return lang('HealthKindSleep');
    if (kind === MOOD_KIND) return lang('HealthKindMood');
    const key = kindTitleKey(kind);
    return key ? lang(key) : kind;
  }

  function renderPeriods(kind: string) {
    if (kind === WORKOUT_KIND) {
      return <span className={buildClassName(kit.chip, kit.chipOn)}>{lang('HealthSevenDays')}</span>;
    }
    if (NO_PERIOD_KINDS.includes(kind) || kind === WATER_KIND) return undefined;
    return (
      <div className={styles.periodChips} role="tablist">
        {PERIODS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={item === period}
            className={buildClassName(kit.chip, item === period && kit.chipOn)}
            data-health-period={item}
            onClick={handlePeriod}
          >
            {lang(PERIOD_KEYS[item])}
          </button>
        ))}
      </div>
    );
  }

  function renderHeader() {
    if (detailKind) {
      return (
        <header className={styles.header}>
          {!isWide && (
            <button type="button" className={kit.ib} aria-label={lang('Back')} onClick={handleBack}>
              <ParvaneIcon name="left" />
            </button>
          )}
          <div className={buildClassName(styles.headerTitle, kit.grow)}>
            <h1 className={styles.title} data-health-title>{renderTitle(detailKind)}</h1>
            {isWide && view && period === 'month' && !NO_PERIOD_KINDS.includes(detailKind) && (
              <div className={buildClassName(kit.muted, kit.small)}>
                {lang('HealthRecordsFor')}
                {' '}
                {formatDate(lang.code, new Date(`${view.today}T12:00:00`), MONTH_FORMAT)}
              </div>
            )}
          </div>
          {renderPeriods(detailKind)}
        </header>
      );
    }
    return (
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h1 className={styles.title}>{lang('PlannerHealth')}</h1>
          {(!isPhone || isFirst) && (
            <div className={buildClassName(kit.muted, kit.small)}>
              {isFirst ? lang('HealthFirstSubtitle')
                : view && formatDate(lang.code, new Date(`${view.today}T12:00:00`), DATE_FORMAT)}
            </div>
          )}
        </div>
        {!isFirst && !isPhone && (
          <div className={styles.headerQuick}>
            <HealthQuickInput request={quickRequest} onRequestHandled={handleRequestHandled} />
          </div>
        )}
        {!isFirst && (isPhone ? (
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('HealthBlocksAria')}
            data-health-blocks
            onClick={handleOpenBlocks}
          >
            <ParvaneIcon name="sliders" />
          </button>
        ) : (
          <button type="button" className={kit.btn} data-health-blocks onClick={handleOpenBlocks}>
            {lang('HealthBlocks')}
          </button>
        ))}
      </header>
    );
  }

  function renderBody() {
    if (!view) {
      if (status === 'ready' || status === 'loading') {
        return <PvLoading data-health-status={status} onRetry={retryHealth} />;
      }
      return <PvEmpty text={lang(STATUS_KEYS[status])} data-health-status={status} />;
    }
    if (detailKind) {
      return (
        <HealthDetail
          view={view}
          kind={detailKind}
          period={NO_PERIOD_KINDS.includes(detailKind) ? 'week' : period}
          isWide={isWide}
          hasFood={blocks.includes('food')}
          onBed={handleBed}
          onWake={handleWake}
          onEdit={handleEdit}
          onNap={handleNap}
          onGoal={setGoalTarget}
        />
      );
    }
    if (isFirst) {
      return (
        <HealthFirst
          blocks={blocks}
          isWide={!isPhone}
          request={quickRequest}
          onExample={handleExample}
          onRequestHandled={handleRequestHandled}
          onDone={handleFirstDone}
        />
      );
    }
    return (
      <HealthSummary
        view={view}
        blocks={blocks}
        metrics={orderMetrics(view.metrics).filter((metric) => (
          metric.kind !== MOOD_KIND && metric.kind !== WATER_KIND && !hiddenKinds.includes(metric.kind)
        ))}
        recent={view.recent.filter((entry) => !hiddenKinds.includes(entry.kind))}
        isNarrow={!isWide}
        onOpen={handleOpen}
        onBed={handleBed}
        onWake={handleWake}
        onEdit={handleEdit}
        onOpenBlocks={handleOpenBlocks}
      />
    );
  }

  const hasSide = Boolean(detailKind && view && isWide);

  return (
    <div
      id="ParvaneHealth"
      className={buildClassName(styles.root, hasSide && styles.rootWithSide)}
      data-health-status={status}
    >
      {hasSide && (
        <HealthSideNav
          view={view!}
          blocks={blocks}
          selected={detailKind!}
          onSelect={handleOpen}
          onBack={handleBack}
          onOpenBlocks={handleOpenBlocks}
        />
      )}
      <div className={styles.main}>
        {renderHeader()}
        {view && status === 'offline' && <PvOfflineBar text={lang('PvOfflineHealth')} onRetry={retryHealth} />}
        {view && status !== 'ready' && status !== 'offline' && (
          <div className={styles.notice} role="status">
            {lang(STATUS_KEYS[status] || 'HealthStatusLoading')}
          </div>
        )}
        <div className={buildClassName(styles.body, 'custom-scroll')}>{renderBody()}</div>
      </div>
      {view && (
        <HealthEntrySheet
          target={sheetTarget}
          today={view.today}
          goalMinutes={view.sleep.goalMinutes}
          isWide={!isPhone}
          onNap={handleNapOn}
          onClose={handleSheetClose}
        />
      )}
      <HealthGoalSheet target={goalTarget} onClose={handleGoalClose} />
      <HealthQuickSheet isWide={!isPhone} onEdit={handleQuickEdit} />
    </div>
  );
};

function readIsFirstDone() {
  try {
    return Boolean(localStorage.getItem(FIRST_DONE_KEY));
  } catch {
    return false;
  }
}

export default memo(Health);
