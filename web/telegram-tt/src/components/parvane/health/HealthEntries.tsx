import { memo, useState } from '../../../lib/teact/teact';

import type { HealthEntry } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  entryClock, formatDelta, formatDurationShort, formatNumber, formatValue, MOOD_KIND, NO_SLEEP_TAG,
} from './healthFormat';
import { getHealthState } from './healthStore';
import useHealthLabels from './useHealthLabels';

import useDerivedState from '../../../hooks/useDerivedState';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  entries: HealthEntry[];
  today: string;
  // Сводка: вид | значение | когда (доска `DeskHealth`)
  withKind?: boolean;
  // Компьютер: день с датой, одиночный щелчок выбирает строку, двойной открывает правку (доска `ZdHealthX`)
  isWide?: boolean;
  // Цель показателя: изменение к цели — зелёным, от цели — оранжевым
  goal?: number;
  onEdit: (entry: HealthEntry) => void;
};

const SLEEP_MARKS = ['sleep_start', 'sleep_end'];
const NUMBER_KINDS_WITHOUT_UNIT = ['weight', 'pulse', 'pressure', 'steps'];

// Parvane (spec 038, 041; доски `HealthSleep`, `HealthWeight`, `RpHealth`, `DeskHealthDetail`, `RdHealth`,
// `ZdHealthX`): записи подробного экрана — день словом и время, значение, изменение к предыдущей записи (у сна —
// отрезок и отклонение от цели, у давления — пульс той же минуты). Удаление — из окна правки
const HealthEntries = ({
  entries, today, withKind, isWide, goal, onEdit,
}: OwnProps) => {
  const {
    lang, kindTitle, unitTitle, entryValue, entryWhen, entryTitle, dayTitle, dayWord,
  } = useHealthLabels(today);
  // Правки, которые не ушли из-за связи (доска `PhStates`)
  const { unsentIds } = useDerivedState(getHealthState);
  const [selectedId, setSelectedId] = useState<string>();

  const findEntry = (e: React.SyntheticEvent<HTMLElement>) => entries.find((entry) => (
    entry.id === e.currentTarget.dataset.id
  ))!;

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (isWide) {
      setSelectedId(e.currentTarget.dataset.id);
      return;
    }
    onEdit(findEntry(e));
  });

  const handleDoubleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (isWide) onEdit(findEntry(e));
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isWide || e.key !== 'Enter') return;
    e.preventDefault();
    onEdit(findEntry(e));
  });

  if (!entries.length) return <div className={buildClassName(kit.muted, styles.empty)}>{lang('HealthNoEntries')}</div>;

  function renderDelta(entry: HealthEntry) {
    if (entry.kind === 'sleep') {
      if (entry.goalDelta === undefined || !entry.goalDelta) return undefined;
      return (
        <span className={entry.goalDelta < 0 ? styles.warn : styles.good} data-health-entry-delta>
          {`${formatDelta(entry.goalDelta, lang.code)} ${lang('HealthUnitMin')}`}
        </span>
      );
    }
    if (entry.kind === 'pressure') {
      return entry.pulse !== undefined ? (
        <span className={kit.muted}>
          {`${lang('HealthKindPulse').toLowerCase()} ${formatNumber(entry.pulse, lang.code)}`}
        </span>
      ) : undefined;
    }
    if (entry.delta === undefined || Math.abs(entry.delta) < 0.05) return undefined;
    const isToGoal = goal !== undefined && (entry.delta < 0) === (entry.value - entry.delta > goal);
    return (
      <span className={goal === undefined ? kit.muted : isToGoal ? styles.good : styles.warn} data-health-entry-delta>
        {formatDelta(entry.delta, lang.code)}
      </span>
    );
  }

  function renderMain(entry: HealthEntry) {
    if (withKind) {
      const isNight = entry.kind === 'sleep' && entry.endMs > entry.atMs;
      return (
        <>
          <span className={styles.entryKind}>{kindTitle(entry.kind)}</span>
          <span className={buildClassName(kit.mono, styles.entryValue)}>{entryValue(entry)}</span>
          <span className={buildClassName(kit.muted, kit.small, styles.entryWhen)}>
            {isNight ? dayTitle(entry.day) : entryWhen(entry)}
          </span>
        </>
      );
    }
    if (entry.kind === 'sleep') {
      const minutes = entry.endMs > entry.atMs ? (entry.endMs - entry.atMs) / 60000 : entry.value;
      const span = entry.endMs > entry.atMs ? entryValue(entry) : '';
      return (
        <>
          <span className={styles.entryKind}>
            {isWide && span ? `${dayWord(entry.day)} · ${span}` : dayWord(entry.day)}
            {!isWide && span && <span className={buildClassName(kit.muted, kit.small, styles.entrySub)}>{span}</span>}
          </span>
          <span className={buildClassName(kit.mono, styles.entryValue)}>
            {entry.tag === NO_SLEEP_TAG ? lang('HealthSleepNoSleep') : formatDurationShort(minutes)}
          </span>
          {renderDelta(entry)}
        </>
      );
    }
    if (SLEEP_MARKS.includes(entry.kind)) {
      return (
        <>
          <span className={styles.entryKind}>{`${dayWord(entry.day)} · ${kindTitle(entry.kind)}`}</span>
          <span className={buildClassName(kit.mono, styles.entryValue)}>{entryClock(entry)}</span>
        </>
      );
    }
    const unit = unitTitle(entry.unit);
    const isBare = NUMBER_KINDS_WITHOUT_UNIT.includes(entry.kind) && !isWide;
    const value = entry.kind === MOOD_KIND || !NUMBER_KINDS_WITHOUT_UNIT.includes(entry.kind) ? entryValue(entry)
      : isBare || !unit || entry.kind === 'pressure' ? formatValue(entry, lang.code)
        : `${formatValue(entry, lang.code)} ${unit}`;
    return (
      <>
        <span className={styles.entryKind}>{isWide ? dayWord(entry.day, true) : entryTitle(entry)}</span>
        {isWide && <span className={buildClassName(kit.mono, kit.muted, styles.entryTime)}>{entryClock(entry)}</span>}
        <span className={buildClassName(kit.mono, styles.entryValue)}>{value}</span>
        {renderDelta(entry)}
      </>
    );
  }

  return (
    <ul className={buildClassName(styles.entries, isWide && styles.entriesWide)} data-health-entries>
      {entries.map((entry) => (
        <li
          key={entry.id}
          className={buildClassName(styles.entry, selectedId === entry.id && styles.entrySelected)}
          data-kind={entry.kind}
        >
          <button
            type="button"
            className={styles.entryMain}
            aria-label={lang('HealthEntryEdit', { name: `${kindTitle(entry.kind)} ${entryValue(entry)}` })}
            data-id={entry.id}
            data-health-entry-edit
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
          >
            {renderMain(entry)}
            {Boolean(entry.note) && (
              <span className={buildClassName(kit.muted, kit.small, styles.entryNote)}>{entry.note}</span>
            )}
            {unsentIds.includes(entry.id) && (
              <span className={styles.entryUnsent} data-unsent>{lang('ParvaneUnsentMark')}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
};

export default memo(HealthEntries);
