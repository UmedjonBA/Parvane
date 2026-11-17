import { memo } from '../../../lib/teact/teact';

import type { HealthEntry } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { deleteHealthEntry } from './healthStore';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  entries: HealthEntry[];
  today: string;
  withKind?: boolean;
};

// Parvane (spec 038): список записей — вид, значение, когда; запись удаляется крестиком
const HealthEntries = ({ entries, today, withKind }: OwnProps) => {
  const {
    lang, kindTitle, entryValue, entryWhen,
  } = useHealthLabels(today);

  const handleDelete = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void deleteHealthEntry(e.currentTarget.dataset.id!);
  });

  if (!entries.length) return <div className={buildClassName(kit.muted, styles.empty)}>{lang('HealthNoEntries')}</div>;

  return (
    <ul className={styles.entries} data-health-entries>
      {entries.map((entry) => (
        <li key={entry.id} className={styles.entry} data-kind={entry.kind}>
          {withKind && <span className={styles.entryKind}>{kindTitle(entry.kind)}</span>}
          <span className={buildClassName(kit.mono, styles.entryValue)}>{entryValue(entry)}</span>
          <span className={buildClassName(kit.muted, kit.small, styles.entryWhen)}>{entryWhen(entry)}</span>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('HealthDeleteEntry', { name: `${kindTitle(entry.kind)} ${entryValue(entry)}` })}
            data-id={entry.id}
            onClick={handleDelete}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
};

export default memo(HealthEntries);
