import { memo, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { MOOD_KIND } from './healthFormat';
import { addHealthEntries } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

const SCORE_KEYS = [
  'HealthMoodScore1', 'HealthMoodScore2', 'HealthMoodScore3', 'HealthMoodScore4', 'HealthMoodScore5',
] as const;
const NOTE_MAX = 500;

// Parvane (spec 041, доска `XpHealth`): самочувствие шкалой из пяти точек с заметкой по желанию. Запись —
// та же, что строкой «самочувствие 4»
const HealthMoodScale = () => {
  const lang = useLang();
  const [score, setScore] = useState<number>();
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setScore(Number(e.currentTarget.dataset.score));
  });

  const handleNote = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNote(e.currentTarget.value);
  });

  const handleSave = useLastCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!score || isSaving) return;
    setIsSaving(true);
    const isAdded = await addHealthEntries([{
      kind: MOOD_KIND,
      atMs: Date.now(),
      endMs: 0,
      tzMin: -new Date().getTimezoneOffset(),
      value: score,
      value2: 0,
      unit: 'score',
      source: 'manual',
      note: note.trim(),
    }]);
    setIsSaving(false);
    if (!isAdded) return;
    setScore(undefined);
    setNote('');
  });

  return (
    <form className={buildClassName(kit.card, styles.card)} data-health-mood-scale onSubmit={handleSave}>
      <div className={styles.moodAsk}>{lang('HealthMoodAsk')}</div>
      <div className={styles.moodScale} role="radiogroup" aria-label={lang('HealthKindMood')}>
        {SCORE_KEYS.map((key, index) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={score === index + 1}
            className={buildClassName(styles.moodDot, score === index + 1 && styles.moodDotOn)}
            data-score={index + 1}
            onClick={handlePick}
          >
            <span className={buildClassName(kit.mono, styles.moodNumber)}>{index + 1}</span>
            <span className={styles.moodLabel}>{lang(key)}</span>
          </button>
        ))}
      </div>
      <label className={styles.field}>
        <span className={buildClassName(kit.muted, kit.small)}>{lang('HealthMoodNote')}</span>
        <input
          className={kit.input}
          type="text"
          value={note}
          maxLength={NOTE_MAX}
          placeholder={lang('HealthMoodNoteExample')}
          autoComplete="off"
          data-health-mood-note
          onChange={handleNote}
        />
      </label>
      <button
        type="submit"
        className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
        disabled={!score || isSaving}
        data-health-mood-save
      >
        {lang('HealthRecord')}
      </button>
    </form>
  );
};

export default memo(HealthMoodScale);
