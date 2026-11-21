import { memo, useState } from '../../../lib/teact/teact';

import type { HealthParsedEntry, HealthParseResult } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatDate } from '../planner/plannerFormat';
import {
  kindTitleKey, localDayKey, parsedValue,
} from './healthFormat';
import useHealthLabels from './useHealthLabels';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  parsed: HealthParseResult;
  // Одна понятая запись — плашкой с галочкой и «Enter» (доска `DeskHealth`)
  withEnter?: boolean;
  // Первое открытие: «Как понято» строками (доска `ZdHealthX`)
  isRows?: boolean;
};

// Запись «сейчас» — в пределах пяти минут
const NOW_SLACK_MS = 5 * 60 * 1000;
const DATE_LONG = { day: 'numeric', month: 'long' } as const;

// Как движок понял строку ввода (HEALTH-2): плашка на каждую запись и на каждый непонятый кусок. Общие для
// строки ввода «Здоровья» и окна ввода «Плана». Когда — словами: «сейчас», «сегодня, 07:20», «ночь на 15 ноября».
// Еда с числами из прошлой записи помечена «как в прошлый раз»
const HealthParsedChips = ({ parsed, withEnter, isRows }: OwnProps) => {
  // «Сегодня» — на момент показа разбора
  const [today] = useState(() => localDayKey(new Date()));
  const { lang, dayTitle, shortDuration } = useHealthLabels(today);

  function whenOf(entry: HealthParsedEntry) {
    if (entry.kind === 'sleep' && entry.endMs) {
      const date = formatDate(lang.code, new Date(`${entry.endDay}T12:00:00`), DATE_LONG);
      return `${lang('HealthNightOn')} ${date}`;
    }
    if (Math.abs(entry.atMs - Date.now()) < NOW_SLACK_MS) return lang('HealthNow');
    return `${dayTitle(entry.day)}, ${entry.time}`;
  }

  function titleOf(entry: HealthParsedEntry) {
    const titleKey = kindTitleKey(entry.kind);
    return titleKey ? lang(titleKey) : entry.kind;
  }

  if (isRows) {
    return (
      <div className={styles.parsedRows}>
        {parsed.entries.map((entry, index) => (
          <div key={`${entry.kind}${index}`} className={styles.parsedRow} data-kind={entry.kind}>
            <span className={styles.parsedDot} />
            <span className={kit.grow}>
              <span>{entry.name ? `${titleOf(entry)} · ${entry.name}` : titleOf(entry)}</span>
              <span className={buildClassName(kit.muted, kit.small, styles.parsedWhen)}>{whenOf(entry)}</span>
            </span>
            <b className={kit.mono}>
              {entry.kind === 'sleep' && entry.endMs
                ? `${parsedValue(entry, lang.code)} · ${shortDuration(entry.value)}`
                : parsedValue(entry, lang.code)}
            </b>
          </div>
        ))}
        {parsed.unparsed.map((piece) => (
          <div key={piece} className={buildClassName(styles.parsedRow, styles.quickChipUnparsed)} data-unparsed>
            {lang('HealthQuickUnparsed', { text: piece })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {parsed.entries.map((entry, index) => (
        <span key={`${entry.kind}${index}`} className={styles.quickChip} data-kind={entry.kind}>
          {withEnter && <ParvaneIcon name="check" isSmall className={styles.quickCheck} />}
          {titleOf(entry)}
          {Boolean(entry.name) && ` · ${entry.name}`}
          {' · '}
          <b className={kit.mono}>{parsedValue(entry, lang.code)}</b>
          {' · '}
          <span data-health-parsed-when>{whenOf(entry)}</span>
          {entry.recalled && (
            <span className={kit.muted} data-recalled>
              {' · '}
              {lang('HealthQuickRecalled')}
            </span>
          )}
          {withEnter && <span className={kit.muted}>{` · ${lang('HealthQuickEnter')}`}</span>}
        </span>
      ))}
      {parsed.unparsed.map((piece) => (
        <span key={piece} className={buildClassName(styles.quickChip, styles.quickChipUnparsed)} data-unparsed>
          {lang('HealthQuickUnparsed', { text: piece })}
        </span>
      ))}
    </>
  );
};

export default memo(HealthParsedChips);
