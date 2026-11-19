import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { NotesMergeChoice } from './notesMerge';
import type { NoteConflict } from './notesOutbox';

import buildClassName from '../../../util/buildClassName';
import { formatNoteEdited } from './notesList';
import { isConflictPart, mergeNotes } from './notesMerge';
import { resolveNoteConflict } from './notesStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  conflict: NoteConflict;
  onDone: NoneToVoidFunction;
};

// Экран расхождения правок (доски `RpNotes`, `ZdNotesX`): заметку изменили на двух устройствах — в каждом месте,
// где правки разошлись, выбирается своя строка, чужая либо обе. Остальное движок свёл сам (NOTES-2). Пока не
// выбрано, на устройствах остаются обе версии: своя — в заметке, чужая — копией «… (конфликт …)»
const NoteConflictView = ({ conflict, onDone }: OwnProps) => {
  const lang = useLang();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const merged = useMemo(
    () => mergeNotes(conflict.base, conflict.mine, conflict.theirs), [conflict],
  );
  const places = useMemo(() => merged.parts.filter(isConflictPart), [merged]);
  const [choices, setChoices] = useState<NotesMergeChoice[]>([]);
  const [now] = useState(() => Date.now());

  const handleChoose = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    const index = Number(e.currentTarget.dataset.place);
    const choice = e.currentTarget.dataset.choice as NotesMergeChoice;
    setChoices((prev) => {
      const next = places.map((_, at) => prev[at] || 'mine');
      next[index] = choice;
      return next;
    });
  });

  const finish = useLastCallback(async (keepCopy?: boolean) => {
    if (isBusy) return;
    markBusy();
    const isDone = await resolveNoteConflict(conflict.node, places.map((_, at) => choices[at] || 'mine'), keepCopy);
    unmarkBusy();
    if (isDone) onDone();
  });

  const handleSave = useLastCallback(() => finish());
  const handleKeepCopy = useLastCallback(() => finish(true));

  function renderChoice(index: number, choice: NotesMergeChoice, who: string, lines: string[]) {
    const isOn = (choices[index] || 'mine') === choice;
    return (
      <label
        className={buildClassName(styles.choice, isOn && styles.choiceOn)}
        data-place={index}
        data-choice={choice}
        data-conflict-choice={choice}
        onClick={handleChoose}
      >
        <input
          type="radio"
          className={styles.choiceRadio}
          name={`note-conflict-${index}`}
          checked={isOn}
          readOnly
        />
        <span className={styles.choiceBody}>
          <span className={styles.choiceWho}>{who}</span>
          <span className={styles.choiceText}>{lines.length ? lines.join('\n') : lang('KnowledgeConflictEmpty')}</span>
        </span>
      </label>
    );
  }

  const mineWho = lang('KnowledgeConflictMine', { when: formatNoteEdited(lang, conflict.at, now) });

  return (
    <div className={styles.conflict} data-note-conflict-view>
      {places.map((place, index) => (
        <div key={index} className={styles.place} data-conflict-place={index}>
          <div className={styles.conflictPlace}>
            {lang('KnowledgeConflictPlace', { index: index + 1, total: places.length, line: place.line })}
          </div>
          {renderChoice(index, 'mine', mineWho, place.mine)}
          {renderChoice(index, 'theirs', lang('KnowledgeConflictTheirs'), place.theirs)}
          <button
            type="button"
            className={buildClassName(kit.chip, styles.both, choices[index] === 'both' && kit.chipOn)}
            aria-pressed={choices[index] === 'both'}
            data-place={index}
            data-choice="both"
            data-conflict-both
            onClick={handleChoose}
          >
            {lang('KnowledgeConflictBoth')}
          </button>
        </div>
      ))}
      <div className={styles.hint}>
        {lang('KnowledgeConflictAuto', { count: merged.autoLines }, { pluralValue: merged.autoLines })}
      </div>
      <span className={styles.grow} />
      <button
        type="button"
        className={buildClassName(kit.btn, kit.btnAcc)}
        disabled={isBusy}
        data-conflict-save
        onClick={handleSave}
      >
        {lang('KnowledgeConflictSave')}
      </button>
      <button type="button" className={kit.btn} disabled={isBusy} data-conflict-keep onClick={handleKeepCopy}>
        {lang('KnowledgeConflictKeepCopy')}
      </button>
    </div>
  );
};

export default memo(NoteConflictView);
