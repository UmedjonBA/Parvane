import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { NoteDevice } from './notesDevices';
import type { NotesMergeChoice } from './notesMerge';
import type { NoteConflict } from './notesOutbox';

import buildClassName from '../../../util/buildClassName';
import { describeNoteDevice, isPhoneDevice } from './notesDevices';
import { formatNoteEdited } from './notesList';
import { isConflictPart, mergeNotes } from './notesMerge';
import { keepNoteConflictVersion, resolveNoteConflict } from './notesStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import own from './NoteConflict.module.scss';
import styles from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  conflict: NoteConflict;
  // `columns` — две версии целиком (компьютер, `ZdNotesX`), `places` — место за местом (телефон, `RpNotes`)
  layout: 'columns' | 'places';
  onDone: NoneToVoidFunction;
};

const KIND_KEYS = { phone: 'KnowledgeConflictPhone', computer: 'KnowledgeConflictComputer' } as const;

// Экран расхождения правок: заметку изменили на двух устройствах. На компьютере — две версии рядом, «Оставить эту»
// у каждой и «Оставить обе»; на телефоне — в каждом месте, где правки разошлись, своя строка, чужая либо обе.
// Остальное движок свёл сам (NOTES-2). Пока не выбрано, на устройствах остаются обе версии: своя — в заметке,
// чужая — копией «… (конфликт …)»
const NoteConflictView = ({ conflict, layout, onDone }: OwnProps) => {
  const lang = useLang();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const merged = useMemo(
    () => mergeNotes(conflict.base, conflict.mine, conflict.theirs), [conflict],
  );
  const places = useMemo(() => merged.parts.filter(isConflictPart), [merged]);
  const [choices, setChoices] = useState<NotesMergeChoice[]>([]);
  const [now] = useState(() => Date.now());
  const [theirDevice, setTheirDevice] = useState<NoteDevice>({});

  useEffect(() => {
    let isActual = true;
    void describeNoteDevice(conflict.theirsDevice).then((device) => {
      if (isActual) setTheirDevice(device);
    });
    return () => {
      isActual = false;
    };
  }, [conflict.theirsDevice]);

  const handleChoose = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    const index = Number(e.currentTarget.dataset.place);
    const choice = e.currentTarget.dataset.choice as NotesMergeChoice;
    setChoices((prev) => {
      const next = places.map((_, at) => prev[at] || 'mine');
      next[index] = choice;
      return next;
    });
  });

  const run = useLastCallback(async (action: () => Promise<boolean>) => {
    if (isBusy) return;
    markBusy();
    const isDone = await action();
    unmarkBusy();
    if (isDone) onDone();
  });

  const handleSave = useLastCallback(() => run(
    () => resolveNoteConflict(conflict.node, places.map((_, at) => choices[at] || 'mine')),
  ));
  const handleKeepCopy = useLastCallback(() => run(() => resolveNoteConflict(conflict.node, [], true)));
  const handleKeepVersion = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const version = e.currentTarget.dataset.version as 'mine' | 'theirs';
    void run(() => keepNoteConflictVersion(conflict.node, version));
  });

  const mineWho = lang('KnowledgeConflictWho', {
    device: lang(isPhoneDevice() ? 'KnowledgeConflictThisPhone' : 'KnowledgeConflictThisComputer'),
    when: formatNoteEdited(lang, conflict.at, now),
  });
  const theirName = theirDevice.kind ? lang(KIND_KEYS[theirDevice.kind])
    : theirDevice.label || lang('KnowledgeConflictTheirs');
  const theirsWho = conflict.theirsAt
    ? lang('KnowledgeConflictWho', { device: theirName, when: formatNoteEdited(lang, conflict.theirsAt, now) })
    : theirName;

  // «Отличия: строка 4 и новая строка 7» — места расхождения по номерам строк
  const differences = lang.conjunction(places.map((place) => lang(
    place.base.length ? 'KnowledgeConflictDiffLine' : 'KnowledgeConflictDiffNew', { line: place.line },
  )));

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

  function renderVersion(version: 'mine' | 'theirs', who: string, text: string, isMarked?: boolean) {
    return (
      <section className={own.version} data-conflict-version={version}>
        <h3 className={own.who}>{who}</h3>
        <pre className={buildClassName(own.text, isMarked && own.textMarked)}>{text}</pre>
        <button
          type="button"
          className={buildClassName(kit.btn, version === 'mine' && kit.btnAcc, own.keep)}
          disabled={isBusy}
          data-version={version}
          data-conflict-keep-version={version}
          onClick={handleKeepVersion}
        >
          {lang('KnowledgeConflictKeepThis')}
        </button>
        {version === 'theirs' && Boolean(places.length) && (
          <p className={own.diff} data-conflict-diff>{lang('KnowledgeConflictDiff', { list: differences })}</p>
        )}
      </section>
    );
  }

  if (layout === 'columns') {
    return (
      <div className={own.root} data-note-conflict-view="columns">
        <header className={own.head}>
          <div className={own.headText}>
            <h2 className={own.title}>{lang('KnowledgeConflictTitle', { title: conflict.title })}</h2>
            <span className={own.subtitle}>{lang('KnowledgeConflictSubtitle')}</span>
          </div>
          <button type="button" className={kit.btn} disabled={isBusy} data-conflict-keep onClick={handleKeepCopy}>
            {lang('KnowledgeConflictKeepBoth')}
          </button>
        </header>
        <div className={own.note} role="status">{lang('KnowledgeConflictPick')}</div>
        <div className={own.columns}>
          {renderVersion('mine', mineWho, conflict.mine)}
          {renderVersion('theirs', theirsWho, conflict.theirs, true)}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.conflict} data-note-conflict-view="places">
      <div className={own.note} role="status">
        <b className={styles.conflictLead}>{lang('KnowledgeConflictBanner')}</b>
        {` ${lang('KnowledgeConflictHint')}`}
      </div>
      {places.map((place, index) => (
        <div key={index} className={styles.place} data-conflict-place={index}>
          <div className={styles.conflictPlace}>
            {lang('KnowledgeConflictPlace', { index: index + 1, total: places.length, line: place.line })}
          </div>
          {renderChoice(index, 'mine', mineWho, place.mine)}
          {renderChoice(index, 'theirs', theirsWho, place.theirs)}
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
