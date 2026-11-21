import { memo, useState } from '../../../lib/teact/teact';

import type { HealthParsedEntry, HealthParseResult } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { MODULE_TITLE_KEYS } from '../../main/parvaneModuleNav';
import { formatDate } from '../planner/plannerFormat';
import { localDayKey, parsedValue } from './healthFormat';
import { getHealthState } from './healthStore';
import { buildSleepVerdict, isSleepSpan } from './healthUnderstood';
import useHealthLabels from './useHealthLabels';

import useDerivedState from '../../../hooks/useDerivedState';
import useLastCallback from '../../../hooks/useLastCallback';

import HealthParsedChips from './HealthParsedChips';

import kit from '../notes/PvKit.module.scss';
import styles from './HealthQuick.module.scss';

type OwnProps = {
  parsed: HealthParseResult;
  // Окно «Новая запись»: к виду дописывается модуль («Понято как «Сон» · модуль «Здоровье»»)
  withModule?: boolean;
  // «Изменить» — полная форма записи этого вида с полями из разбора
  onEdit?: (entry: HealthParsedEntry) => void;
  // «Другие чтения» — та же строка записью «Плана»
  onAlternatives?: NoneToVoidFunction;
};

const DATE_LONG = { day: 'numeric', month: 'long' } as const;

// Parvane (доски `PlusModes`, `DeskOverlays`): как строка ляжет в «Здоровье» — вид, раскладка (у ночи «Отбой /
// Подъём / Всего», у показателя — значение и когда) и вывод против цели сна. Несколько записей — строками
const HealthUnderstood = ({
  parsed, withModule, onEdit, onAlternatives,
}: OwnProps) => {
  // «Сегодня» — на момент показа разбора
  const [today] = useState(() => localDayKey(new Date()));
  const {
    lang, kindTitle, dayTitle, duration, shortDuration,
  } = useHealthLabels(today);
  const sleep = useDerivedState(getHealthState).view?.sleep;
  const [first] = parsed.entries;
  const isSingle = parsed.entries.length === 1 && !parsed.unparsed.length;

  const handleEdit = useLastCallback(() => onEdit!(first));

  if (!first) return undefined;

  const kind = kindTitle(first.kind === 'sleep_start' || first.kind === 'sleep_end' ? 'sleep' : first.kind);
  const title = isSingle ? lang('PvQuickUnderstood', { kind }) : lang('PvQuickUnderstoodMany');
  const moduleText = withModule ? lang('PvQuickInModule', { module: lang(MODULE_TITLE_KEYS.health) }) : undefined;

  function renderVerdict(entry: HealthParsedEntry) {
    const verdict = buildSleepVerdict(entry, today, sleep?.goalMinutes, sleep?.goalBedMin);
    const wakeDay = entry.endDay || entry.day;
    const night = verdict.night === 'today' ? lang('PvQuickNightToday')
      : verdict.night === 'yesterday' ? lang('PvQuickNightYesterday')
        : lang('PvQuickNightOn', { date: formatDate(lang.code, new Date(`${wakeDay}T12:00:00`), DATE_LONG) });
    const parts = [night];
    if (verdict.totalDelta !== undefined) {
      parts.push(verdict.totalDelta === 0 ? lang('HealthSleepOnGoal') : lang(
        verdict.totalDelta < 0 ? 'HealthSleepBelowGoal' : 'HealthSleepAboveGoal',
        { duration: shortDuration(verdict.totalDelta) },
      ));
    }
    if (verdict.bedDelta) {
      parts.push(lang(verdict.bedDelta > 0 ? 'PvQuickBedLater' : 'PvQuickBedEarlier', {
        duration: shortDuration(verdict.bedDelta),
      }));
    }
    return (
      <div className={buildClassName(kit.small, styles.verdict)} data-health-verdict>
        {parts.map((part, index) => (index ? [' · ', part] : part))}
      </div>
    );
  }

  function renderLayout(entry: HealthParsedEntry) {
    if (isSleepSpan(entry)) {
      return (
        <div className={styles.layout}>
          <div className={styles.cell}>
            <span className={buildClassName(kit.muted, kit.small)}>{lang('HealthSleepBedField')}</span>
            <b className={kit.mono}>{entry.time}</b>
          </div>
          <div className={styles.cell}>
            <span className={buildClassName(kit.muted, kit.small)}>{lang('HealthSleepWakeField')}</span>
            <b className={kit.mono}>{entry.endTime}</b>
          </div>
          <div className={styles.cell}>
            <span className={buildClassName(kit.muted, kit.small)}>{lang('PvQuickTotal')}</span>
            <b className={kit.mono}>{duration(entry.value)}</b>
          </div>
        </div>
      );
    }
    return (
      <div className={styles.layout}>
        <div className={styles.cell}>
          <span className={buildClassName(kit.muted, kit.small)}>{entry.name || kind}</span>
          <b className={kit.mono}>{parsedValue(entry, lang.code)}</b>
        </div>
        <div className={styles.cell}>
          <span className={buildClassName(kit.muted, kit.small)}>{lang('PvQuickWhen')}</span>
          <b>{entry.kind === 'sleep' ? lang('PvQuickNightToday') : `${dayTitle(entry.day)}, ${entry.time}`}</b>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.understood} data-health-understood data-kind={first.kind}>
      <div className={styles.head}>
        <span className={styles.title}>
          {title}
          {withModule && (
            <span className={kit.muted}>
              {' · '}
              {moduleText}
            </span>
          )}
        </span>
        {onAlternatives && (
          <button type="button" className={styles.link} data-quick-other onClick={onAlternatives}>
            {lang('PlannerQuickAlternatives')}
          </button>
        )}
        {onEdit && isSingle && (
          <button type="button" className={styles.link} data-health-understood-edit onClick={handleEdit}>
            {lang('PvQuickEdit')}
          </button>
        )}
      </div>
      {isSingle ? renderLayout(first) : <HealthParsedChips parsed={parsed} isRows />}
      {isSingle && first.kind === 'sleep' && renderVerdict(first)}
    </div>
  );
};

export default memo(HealthUnderstood);
