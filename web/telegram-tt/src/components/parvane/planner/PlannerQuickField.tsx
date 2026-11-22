import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerLearnedWord, PlannerSettings } from './plannerModel';
import type { QuickDraft } from './plannerQuick';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import { getIsModuleOn } from '../../../util/parvaneModules';
import { addHealthEntries, parseHealthInput } from '../health/healthStore';
import { isWholeHealthLine } from '../health/useHealthParse';
import {
  formatDuration, formatKind, formatWeekdayShort, joinCaption,
} from './plannerFormat';
import { getQuickLang, parseQuickInput } from './plannerQuick';
import { applyQuickDraft } from './plannerQuickApply';
import { learnedDefaults, learnStoreFromWords } from './plannerQuickLearn';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';

import styles from './PlannerPv.module.scss';

type OwnProps = {
  today: string;
  settings: PlannerSettings;
  learnedWords: PlannerLearnedWord[];
  // Строка, которую поле не может записать само (ошибка разбора), — в окно ввода текстом
  onMore: (text: string) => void;
  onCreated: (day?: string) => void;
};

const NAME_MAX_LENGTH = 160;
const INPUT_MAX_LENGTH = 300;

// Поле «Запись строкой» в шапке компьютера (доска `DeskPlan`): набранная строка разбирается тем же разбором, что
// окно ввода, справа внутри поля — что получится («Событие · пн 10:00–11:00 · Enter»); Enter записывает. Строку,
// понятую «Здоровьем» целиком, пишет модуль «Здоровье»; строку с ошибкой разбора — окно ввода с подробностями
const PlannerQuickField = ({
  today, settings, learnedWords, onMore, onCreated,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();
  const [text, setText] = useState('');
  const isSubmittingRef = useRef(false);

  const lang = useLang();

  const learned = useMemo(() => (
    settings.isLearnOff ? undefined : learnedDefaults(learnStoreFromWords(learnedWords))
  ), [settings.isLearnOff, learnedWords]);

  const parse = useLastCallback((value: string): QuickDraft => {
    const now = new Date();
    return parseQuickInput(value, {
      today,
      nowMinutes: now.getHours() * 60 + now.getMinutes(),
      dayStart: settings.dayStart,
      dayEnd: settings.dayEnd,
      lang: getQuickLang(lang.code),
      learned,
    });
  });

  // `parse` читает настройки дня, словарь и язык — по ним разбор пересчитывается
  // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  const draft = useMemo(() => (text.trim() ? parse(text) : undefined), [text, today, settings, learned, lang]);
  // «пн 10:00–11:00»: день недели — когда запись не на сегодня
  const when = draft && [
    draft.day && draft.day !== today ? formatWeekdayShort(lang, draft.day) : undefined,
    draft.start ? (draft.end ? `${draft.start}–${draft.end}` : draft.start) : undefined,
  ].filter(Boolean).join(' ');
  const summary = draft && !draft.error ? joinCaption([
    formatKind(lang, draft.kind),
    when,
    !draft.start && draft.minutes ? formatDuration(lang, draft.minutes) : undefined,
    'Enter',
  ]) : undefined;

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
  });

  const handleMore = useLastCallback(() => {
    const value = inputRef.current?.value ?? text;
    setText('');
    onMore(value);
  });

  const submit = useLastCallback(async () => {
    const value = inputRef.current?.value ?? text;
    if (!value.trim() || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      if (getIsModuleOn('health')) {
        const parsed = await parseHealthInput(value);
        if (parsed && isWholeHealthLine(parsed) && await addHealthEntries(parsed.entries)) {
          setText('');
          onCreated(parsed.entries[0].endDay || parsed.entries[0].day);
          return;
        }
      }
      const entry = parse(value);
      if (entry.error || entry.name.length > NAME_MAX_LENGTH) {
        handleMore();
        return;
      }
      updatePlanner((state) => {
        applyQuickDraft(state, entry);
      }, lang('PlannerNoticeAdded', { name: entry.name || value.trim() }));
      setText('');
      onCreated(entry.day);
    } finally {
      isSubmittingRef.current = false;
    }
  });

  // Enter и Escape поля. Общая очередь клавиш (`captureKeyboardListeners`) ловит их на документе в фазе перехвата
  // раньше поля, если в ней есть обработчики других модулей; пока поле в фокусе, клавиши берутся раньше — на `window`
  const handleWindowKey = useLastCallback((e: KeyboardEvent) => {
    if (e.target !== inputRef.current || e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
    if (e.key === 'Escape') {
      const input = inputRef.current;
      if (!input?.value) return;
      e.stopPropagation();
      setText('');
      // Набранное, не дошедшее до отрисовки, Teact не сотрёт: в разметке осталась та же пустая строка
      requestMutation(() => {
        input.value = '';
      });
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    void submit();
  });

  const handleFocus = useLastCallback(() => {
    window.addEventListener('keydown', handleWindowKey, true);
  });

  const handleBlur = useLastCallback(() => {
    window.removeEventListener('keydown', handleWindowKey, true);
  });

  useEffect(() => handleBlur, [handleBlur]);

  return (
    <div className={styles.quickField} data-planner-quick-field>
      <Icon name="add" className={styles.quickFieldIcon} />
      <input
        ref={inputRef}
        type="text"
        className={styles.quickFieldInput}
        value={text}
        maxLength={INPUT_MAX_LENGTH}
        placeholder={lang('PlannerQuickField')}
        aria-label={lang('PlannerQuickField')}
        autoComplete="off"
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
      {summary ? (
        <span className={styles.quickFieldParse} data-quick-field-summary>
          <Icon name="check" />
          {summary}
        </span>
      ) : draft ? (
        <span className={buildClassName(styles.quickFieldParse, styles.quickFieldParseMuted)}>
          {lang('PlannerQuickFieldMore')}
        </span>
      ) : (
        <span className={styles.quickKey}>Enter</span>
      )}
    </div>
  );
};

export default memo(PlannerQuickField);
