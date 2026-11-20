import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { HealthSheetTarget } from './HealthEntrySheet';
import type { HealthDraft, HealthEntry } from './healthTypes';
import { LeftColumnContent, SettingsScreens } from '../../../types';

import buildClassName from '../../../util/buildClassName';
import {
  consumeHealthAddRequest, getHealthAddRequest, getIsParvaneScreenShown, getParvaneSection, setParvaneSection,
} from '../../../util/parvaneSection';
import { formatDate } from '../planner/plannerFormat';
import {
  BLOCK_KINDS, MOOD_KIND, orderMetrics, WATER_KIND,
} from './healthFormat';
import {
  addHealthEntries, getHealthState, retryHealth, watchHealth,
} from './healthStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvLoading from '../notes/PvLoading';
import PvOfflineBar from '../notes/PvOfflineBar';
import { HealthActivityCard, HealthNutritionCard } from './HealthDayCards';
import HealthDetail from './HealthDetail';
import HealthEntries from './HealthEntries';
import HealthEntrySheet from './HealthEntrySheet';
import HealthFirst from './HealthFirst';
import HealthMetricCard from './HealthMetricCard';
import HealthQuickInput from './HealthQuickInput';
import HealthSleepCard from './HealthSleepCard';
import HealthWaterCard from './HealthWaterCard';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

// Первое открытие закрыто кнопкой «Готово» — на этом устройстве
const FIRST_DONE_KEY = 'parvane:health-first-done';
const RECENT_ON_SUMMARY = 8;
const DATE_FORMAT = { weekday: 'long', day: 'numeric', month: 'long' } as const;
const STATUS_KEYS = {
  'needs-linking': 'HealthStatusNeedsLinking',
  'no-key': 'HealthStatusNoKey',
  offline: 'HealthStatusOffline',
  loading: 'HealthStatusLoading',
} as const;

// Parvane (spec 038, 041): модуль «Здоровье» — сводка (сон, показатели тела, самочувствие, последние записи),
// запись одной строкой и подробный экран показателя. Данные — контейнер домена `parvane.health.v1`; числа
// и разбор ввода — из движка. Какие блоки показывать, решает экран «Профиль → Модули» этого устройства
const Health = () => {
  const { openLeftColumnContent, openSettingsScreen } = getActions();

  const lang = useLang();
  const section = useDerivedState(getParvaneSection);
  const state = useDerivedState(getHealthState);
  const request = useDerivedState(getHealthAddRequest);
  const { prefs } = useParvaneModules();
  const [detailKind, setDetailKind] = useState<string>();
  const [example, setExample] = useState<{ text?: string }>();
  const [sheetTarget, setSheetTarget] = useState<HealthSheetTarget>();
  const [isFirstDone, setIsFirstDone] = useState(readIsFirstDone);

  const isShown = section === 'health';
  useEffect(() => {
    watchHealth(isShown);
  }, [isShown]);

  const { view, status } = state;
  const blocks = prefs.healthBlocks;
  const hiddenKinds = Object.entries(BLOCK_KINDS)
    .filter(([block]) => !blocks.includes(block as typeof blocks[number]))
    .flatMap(([, kinds]) => kinds);
  const metrics = orderMetrics(view?.metrics || []).filter((metric) => (
    metric.kind !== MOOD_KIND && metric.kind !== WATER_KIND && !hiddenKinds.includes(metric.kind)
  ));
  const water = view?.metrics.find((metric) => metric.kind === WATER_KIND);
  const mood = view?.metrics.find((metric) => metric.kind === MOOD_KIND);
  const isEmpty = Boolean(view) && !view.recent.length && !view.metrics.length;
  // Первое открытие — отдельным экраном вместо сводки (доски `ZpHealthX`, `ZdHealthX`); строка ввода — в нём
  const isFirst = isEmpty && !isFirstDone && !detailKind;
  const shownRecent = view?.recent.filter((entry) => !hiddenKinds.includes(entry.kind));

  const addMark = useLastCallback((kind: 'sleep_start' | 'sleep_end') => {
    const now = Date.now();
    const entry: HealthDraft = {
      kind,
      atMs: now,
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

  const handleOpenSleep = useLastCallback(() => setDetailKind('sleep'));
  const handleBack = useLastCallback(() => setDetailKind(undefined));
  const handleOpenMood = useLastCallback(() => setDetailKind(MOOD_KIND));

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

  const handleEdit = useLastCallback((entry: HealthEntry) => setSheetTarget({ entry }));
  const handleNap = useLastCallback(() => setSheetTarget({ napDay: view!.today }));
  const handleSheetClose = useLastCallback(() => setSheetTarget(undefined));

  const handleRequestHandled = useLastCallback(() => {
    if (request) consumeHealthAddRequest();
    setExample(undefined);
  });

  // Запрос «записать показатель» забирает показанный модуль (скрытый после первого показа остаётся смонтированным)
  const quickRequest = (getIsParvaneScreenShown('health') ? request : undefined) || example;

  function renderSummary() {
    if (!view) {
      if (status === 'ready' || status === 'loading') {
        return <PvLoading data-health-status={status} onRetry={retryHealth} />;
      }
      return <PvEmpty text={lang(STATUS_KEYS[status])} data-health-status={status} />;
    }
    if (isFirst) {
      return (
        <HealthFirst
          blocks={blocks}
          request={quickRequest}
          onExample={handleExample}
          onRequestHandled={handleRequestHandled}
          onDone={handleFirstDone}
        />
      );
    }
    return (
      <>
        <div className={styles.grid}>
          {blocks.includes('sleep') && (
            <HealthSleepCard
              sleep={view.sleep}
              today={view.today}
              onOpen={handleOpenSleep}
              onBed={handleBed}
              onWake={handleWake}
            />
          )}
          {blocks.includes('body') && (
            <div className={styles.column}>
              <div className={kit.caps}>{lang('HealthBodyTitle')}</div>
              <div className={styles.metrics}>
                {metrics.map((metric) => (
                  <HealthMetricCard key={metric.kind} metric={metric} today={view.today} onOpen={setDetailKind} />
                ))}
                {!metrics.length && <div className={kit.muted}>{lang('HealthBodyEmpty')}</div>}
              </div>
              <button
                type="button"
                className={buildClassName(kit.card, styles.mood)}
                data-health-card="mood"
                onClick={handleOpenMood}
              >
                <span className={kit.grow}>{lang('HealthKindMood')}</span>
                <span className={mood?.last ? kit.mono : kit.muted}>
                  {mood?.last
                    ? lang('HealthMoodScore', { value: Math.round(mood.last.value) }) : lang('HealthMoodAsk')}
                </span>
              </button>
            </div>
          )}
          {blocks.includes('food') && <HealthNutritionCard nutrition={view.nutrition} onOpen={setDetailKind} />}
          {blocks.includes('water') && <HealthWaterCard metric={water} onOpen={setDetailKind} />}
          {blocks.includes('workouts') && <HealthActivityCard activity={view.activity} onOpen={setDetailKind} />}
        </div>
        <div className={kit.caps}>{lang('HealthRecentTitle')}</div>
        <HealthEntries
          entries={shownRecent!.slice(0, RECENT_ON_SUMMARY)}
          today={view.today}
          withKind
          onEdit={handleEdit}
        />
      </>
    );
  }

  return (
    <div id="ParvaneHealth" className={styles.root} data-health-status={status}>
      <header className={styles.header}>
        {detailKind && (
          <button type="button" className={kit.ib} aria-label={lang('Back')} onClick={handleBack}>
            <ParvaneIcon name="left" />
          </button>
        )}
        <div className={styles.headerTitle}>
          <h1 className={styles.title}>{lang('PlannerHealth')}</h1>
          <div className={buildClassName(kit.muted, kit.small)}>
            {isFirst ? lang('HealthFirstSubtitle')
              : view && formatDate(lang.code, new Date(`${view.today}T12:00:00`), DATE_FORMAT)}
          </div>
        </div>
        {!isFirst && (
          <div className={styles.headerQuick}>
            <HealthQuickInput request={quickRequest} onRequestHandled={handleRequestHandled} />
          </div>
        )}
        {!isFirst && (
          <button type="button" className={kit.btn} onClick={handleOpenBlocks}>{lang('HealthBlocks')}</button>
        )}
      </header>
      {view && status === 'offline' && <PvOfflineBar text={lang('PvOfflineHealth')} onRetry={retryHealth} />}
      {view && status !== 'ready' && status !== 'offline' && (
        <div className={styles.notice} role="status">
          {lang(STATUS_KEYS[status] || 'HealthStatusLoading')}
        </div>
      )}
      <div className={buildClassName(styles.body, 'custom-scroll')}>
        {detailKind && view
          ? (
            <HealthDetail
              view={view}
              kind={detailKind}
              onBed={handleBed}
              onWake={handleWake}
              onEdit={handleEdit}
              onNap={handleNap}
              onExample={handleExample}
            />
          )
          : renderSummary()}
      </div>
      {view && <HealthEntrySheet target={sheetTarget} today={view.today} onClose={handleSheetClose} />}
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
