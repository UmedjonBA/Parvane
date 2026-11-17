import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { HealthParseResult } from './healthTypes';
import { LeftColumnContent, SettingsScreens } from '../../../types';

import buildClassName from '../../../util/buildClassName';
import {
  consumeHealthAddRequest, getHealthAddRequest, getIsParvaneScreenShown, getParvaneSection, setParvaneSection,
} from '../../../util/parvaneSection';
import { formatDate } from '../planner/plannerFormat';
import { BLOCK_KINDS, MOOD_KIND, orderMetrics } from './healthFormat';
import {
  addHealthEntries, getHealthState, watchHealth,
} from './healthStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import ParvaneIcon from '../../main/ParvaneIcon';
import HealthDetail from './HealthDetail';
import HealthEntries from './HealthEntries';
import HealthMetricCard from './HealthMetricCard';
import HealthQuickInput from './HealthQuickInput';
import HealthSleepCard from './HealthSleepCard';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

const EXAMPLE_KEYS = [
  'HealthExampleWeight', 'HealthExampleSleep', 'HealthExamplePressure', 'HealthExamplePulse', 'HealthExampleSteps',
  'HealthExampleMood',
] as const;
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
    metric.kind !== MOOD_KIND && !hiddenKinds.includes(metric.kind)
  ));
  const mood = view?.metrics.find((metric) => metric.kind === MOOD_KIND);
  const isEmpty = Boolean(view) && !view.recent.length && !view.metrics.length;

  const addMark = useLastCallback((kind: 'sleep_start' | 'sleep_end') => {
    const now = Date.now();
    const entry: HealthParseResult['entries'][number] = {
      kind,
      atMs: now,
      endMs: 0,
      tzMin: -new Date().getTimezoneOffset(),
      value: 0,
      value2: 0,
      unit: '',
      source: 'button',
      day: '',
      time: '',
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

  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setExample({ text: e.currentTarget.textContent || '' });
  });

  const handleRequestHandled = useLastCallback(() => {
    if (request) consumeHealthAddRequest();
    setExample(undefined);
  });

  // Запрос «записать показатель» забирает показанный модуль (скрытый после первого показа остаётся смонтированным)
  const quickRequest = (getIsParvaneScreenShown('health') ? request : undefined) || example;

  function renderSummary() {
    if (!view) {
      return (
        <div className={buildClassName(kit.muted, styles.empty)} data-health-status={status}>
          {lang(STATUS_KEYS[status as keyof typeof STATUS_KEYS] || 'HealthStatusLoading')}
        </div>
      );
    }
    return (
      <>
        {isEmpty && (
          <section className={buildClassName(kit.card, styles.card)} data-health-first>
            <div>{lang('HealthFirstText')}</div>
            <div className={kit.caps}>{lang('HealthFirstTry')}</div>
            <div className={styles.examples}>
              {EXAMPLE_KEYS.map((key) => (
                <button key={key} type="button" className={kit.chip} onClick={handleExample}>{lang(key)}</button>
              ))}
            </div>
          </section>
        )}
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
              {mood?.last && (
                <button
                  type="button"
                  className={buildClassName(kit.card, styles.mood)}
                  data-health-card="mood"
                  onClick={handleOpenMood}
                >
                  <span className={kit.grow}>{lang('HealthKindMood')}</span>
                  <span className={kit.mono}>{lang('HealthMoodScore', { value: Math.round(mood.last.value) })}</span>
                </button>
              )}
            </div>
          )}
        </div>
        <div className={kit.caps}>{lang('HealthRecentTitle')}</div>
        <HealthEntries entries={view.recent.slice(0, RECENT_ON_SUMMARY)} today={view.today} withKind />
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
            {view && formatDate(lang.code, new Date(`${view.today}T12:00:00`), DATE_FORMAT)}
          </div>
        </div>
        <div className={styles.headerQuick}>
          <HealthQuickInput request={quickRequest} onRequestHandled={handleRequestHandled} />
        </div>
        <button type="button" className={kit.btn} onClick={handleOpenBlocks}>{lang('HealthBlocks')}</button>
      </header>
      {view && status !== 'ready' && (
        <div className={styles.notice} role="status">
          {lang(STATUS_KEYS[status] || 'HealthStatusLoading')}
        </div>
      )}
      <div className={buildClassName(styles.body, 'custom-scroll')}>
        {detailKind && view
          ? <HealthDetail view={view} kind={detailKind} onBed={handleBed} onWake={handleWake} />
          : renderSummary()}
      </div>
    </div>
  );
};

export default memo(Health);
