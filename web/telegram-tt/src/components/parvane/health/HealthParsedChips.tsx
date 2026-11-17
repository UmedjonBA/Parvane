import { memo } from '../../../lib/teact/teact';

import type { HealthParseResult } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { kindTitleKey, parsedValue } from './healthFormat';

import useLang from '../../../hooks/useLang';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  parsed: HealthParseResult;
};

// Как движок понял строку ввода (HEALTH-2): плашка на каждую запись и на каждый непонятый кусок. Общие для
// строки ввода «Здоровья» и окна ввода «Плана»
const HealthParsedChips = ({ parsed }: OwnProps) => {
  const lang = useLang();

  return (
    <>
      {parsed.entries.map((entry, index) => {
        const titleKey = kindTitleKey(entry.kind);
        return (
          <span key={`${entry.kind}${index}`} className={styles.quickChip} data-kind={entry.kind}>
            {titleKey ? lang(titleKey) : entry.kind}
            {Boolean(entry.name) && ` · ${entry.name}`}
            {' · '}
            <b className={kit.mono}>{parsedValue(entry, lang.code)}</b>
            {' · '}
            {entry.kind === 'sleep' && entry.endMs ? entry.endDay : `${entry.day}, ${entry.time}`}
          </span>
        );
      })}
      {parsed.unparsed.map((piece) => (
        <span key={piece} className={buildClassName(styles.quickChip, styles.quickChipUnparsed)} data-unparsed>
          {lang('HealthQuickUnparsed', { text: piece })}
        </span>
      ))}
    </>
  );
};

export default memo(HealthParsedChips);
