import { memo } from '../../../lib/teact/teact';

import type { HealthEntry } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { deleteHealthEntry, getHealthState } from './healthStore';
import useHealthLabels from './useHealthLabels';

import useDerivedState from '../../../hooks/useDerivedState';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  entries: HealthEntry[];
  today: string;
  withKind?: boolean;
  onEdit: (entry: HealthEntry) => void;
};

// Parvane (spec 038): список записей — вид, значение, когда. Нажатие на запись открывает правку,
// крестик удаляет
const HealthEntries = ({
  entries, today, withKind, onEdit,
}: OwnProps) => {
  const {
    lang, kindTitle, entryValue, entryWhen,
  } = useHealthLabels(today);
  // Правки, которые не ушли из-за связи (доска `PhStates`)
  const { unsentIds } = useDerivedState(getHealthState);

  const handleDelete = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void deleteHealthEntry(e.currentTarget.dataset.id!);
  });

  const handleEdit = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onEdit(entries.find((entry) => entry.id === e.currentTarget.dataset.id)!);
  });

  if (!entries.length) return <div className={buildClassName(kit.muted, styles.empty)}>{lang('HealthNoEntries')}</div>;

  return (
    <ul className={styles.entries} data-health-entries>
      {entries.map((entry) => (
        <li key={entry.id} className={styles.entry} data-kind={entry.kind}>
          <button
            type="button"
            className={styles.entryMain}
            aria-label={lang('HealthEntryEdit', { name: `${kindTitle(entry.kind)} ${entryValue(entry)}` })}
            data-id={entry.id}
            data-health-entry-edit
            onClick={handleEdit}
          >
            {withKind && <span className={styles.entryKind}>{kindTitle(entry.kind)}</span>}
            <span className={buildClassName(kit.mono, styles.entryValue)}>{entryValue(entry)}</span>
            {Boolean(entry.note) && (
              <span className={buildClassName(kit.muted, kit.small, styles.entryNote)}>{entry.note}</span>
            )}
            <span className={buildClassName(kit.muted, kit.small, styles.entryWhen)}>{entryWhen(entry)}</span>
            {unsentIds.includes(entry.id) && (
              <span className={styles.entryUnsent} data-unsent>{lang('ParvaneUnsentMark')}</span>
            )}
          </button>
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
