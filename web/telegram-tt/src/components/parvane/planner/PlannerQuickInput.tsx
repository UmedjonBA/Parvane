import {
  memo, onFullyIdle, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { IconName } from '../../../types/icons';
import type {
  PlannerEvent, PlannerLearnedWord, PlannerQuickLine, PlannerSettings, PlannerTask,
} from './plannerModel';
import type {
  QuickAlt, QuickAltField, QuickContext, QuickDraft, QuickField, QuickKind, QuickLang, QuickPick,
} from './plannerQuick';
import type { LearnStore } from './plannerQuickLearn';
import type { QuickCandidate, QuickHistory } from './plannerQuickSuggest';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import captureKeyboardListeners from '../../../util/captureKeyboardListeners';
import {
  formatDay, formatDayLabel, formatDuration, formatRemind, formatRepeat, formatSpan,
} from './plannerFormat';
import { applyQuickDraft, formatPace } from './plannerHealth';
import { toMinutes, toTime } from './plannerModel';
import { getQuickLang, parseQuickInput, QUICK_REPEAT_END } from './plannerQuick';
import {
  correctWords, hasLearned, learnedDefaults, learnStoreFromWords, mergeLearnStores, readLearned, recordCorrection,
  resetLearned, saveLearned,
} from './plannerQuickLearn';
import {
  buildCandidates, filterSuggestions, forgetQuickLine, forgetSuggestion, hasHistory, historyFromLines,
  isSuggestionPrefix, lineKey, mergeHistories, readHistory, recordHistoryLine, recordQuickLine, resetHistory,
  saveHistory,
} from './plannerQuickSuggest';
import { canSyncLearned, canSyncQuickHistory, updatePlanner } from './plannerStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Modal from '../../ui/Modal';
import { EVENT_ERROR_KEYS, TASK_ERROR_KEYS } from './PlannerTaskForm';

import styles from './Planner.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Строка, с которой окно открывается (пример с экрана «Здоровье»)
  initialText?: string;
  today: string;
  settings: PlannerSettings;
  // Аккаунт: запись словаря правок на устройстве (пока «План» недоступен) — у каждого своя
  userId?: string;
  // Словарь правок ввода текстом из данных «Плана»
  learnedWords: PlannerLearnedWord[];
  // «План» загружен и принимает правки: словарь читается из него и пишется в него
  isLearnedSynced: boolean;
  // История ввода текстом из данных «Плана»; нет — «План» её не ведёт (недоступен либо движок прежней
  // сборки), история читается из записи устройства
  quickLines?: PlannerQuickLine[];
  // Задачи и события «Плана»: из них собираются подсказки для записей, созданных не этим окном
  tasks: PlannerTask[];
  events: PlannerEvent[];
  onCreated: (day?: string) => void;
  // Полная форма записи; без неё (окно открыто вне «Плана») кнопки «Подробнее» нет
  onMore?: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

type KindChoice = 'auto' | 'task' | 'event' | 'food' | 'sleep' | 'workout';
type Chip = {
  field: QuickField;
  text: string;
  isFixed?: boolean;
  // Значение подставлено из словаря правок: снятый чип возвращает обычное
  isLearned?: boolean;
  key?: string;
};

const KIND_CHOICES: KindChoice[] = ['auto', 'event', 'task', 'food', 'sleep', 'workout'];
const KIND_LABELS = {
  auto: 'PlannerQuickAuto',
  event: 'PlannerKindEvent',
  task: 'PlannerKindTask',
  food: 'PlannerKindFood',
  sleep: 'PlannerKindSleep',
  workout: 'PlannerKindWorkout',
} as const;
const DRAFT_KIND_LABELS = {
  event: 'PlannerKindEvent',
  task: 'PlannerKindTask',
  food: 'PlannerKindFood',
  water: 'PlannerHealthWater',
  sleep: 'PlannerKindSleep',
  workout: 'PlannerKindWorkout',
  metric: 'PlannerHealthBody',
  goal: 'PlannerHealthGoals',
} as const satisfies Record<QuickKind, string>;
const KIND_CLASSES = {
  event: styles.kindEvent,
  task: styles.kindTask,
  food: styles.kindFood,
  water: styles.kindFood,
  sleep: styles.kindSleep,
  workout: styles.kindWorkout,
  metric: styles.kindMetric,
  goal: styles.kindMuted,
} satisfies Record<QuickKind, string>;
const KIND_ICONS = {
  event: 'calendar',
  task: 'check',
  food: 'eats',
  water: 'eats',
  sleep: 'darkmode',
  workout: 'sport',
  metric: 'heart-outline',
  goal: 'settings',
} as const satisfies Record<QuickKind, IconName>;
// Виды, которые в переключателе стоят под одной кнопкой
const CHOICE_OF: Partial<Record<QuickKind, KindChoice>> = { water: 'food', metric: 'auto', goal: 'auto' };
// Какие виды строк подсказывать при выбранном виде окна ('auto' — все)
const CHOICE_KINDS: Record<KindChoice, QuickKind[] | undefined> = {
  auto: undefined,
  task: ['task'],
  event: ['event'],
  food: ['food', 'water'],
  sleep: ['sleep'],
  workout: ['workout'],
};
const METRIC_LABELS = {
  weight: 'PlannerHealthWeight',
  pressure: 'PlannerHealthPressure',
  pulse: 'PlannerHealthPulse',
  steps: 'PlannerHealthStepsShort',
  mood: 'PlannerHealthMood',
} as const;
const MEAL_LABELS = {
  breakfast: 'PlannerMealBreakfast',
  lunch: 'PlannerMealLunch',
  dinner: 'PlannerMealDinner',
  snack: 'PlannerMealSnack',
  other: 'PlannerMealOther',
} as const;
const NAME_MAX_LENGTH = 160;
const INPUT_MAX_LENGTH = 300;
const FOCUS_DELAY_MS = 200;
const SUGGESTION_SELECTOR = '[data-quick-suggestion]';
// Столько строк истории и записей «Плана» разбираются сразу при открытии; больше — сначала показываются
// примеры, полный список собирается, когда окно показано и браузер свободен
const SYNC_CANDIDATES_LIMIT = 120;
const MINUTES_IN_DAY_FULL = 1440;
const EMPTY_HISTORY: QuickHistory = { tick: 0, lines: [], hidden: [] };

// Пример с экрана «Здоровье» («бег 5 км 30 мин», «вес 72,4»): вид окна и подсказки только этого вида (у
// показателя — того же показателя, по первому слову строки); иное — не пример
const EXAMPLE_KINDS: Partial<Record<QuickKind, KindChoice>> = {
  food: 'food', water: 'food', sleep: 'sleep', workout: 'workout', metric: 'auto',
};
type ExampleFilter = { choice: KindChoice; kinds: QuickKind[]; lead?: string };

function exampleFilterOf(text: string, today: string, quickLang: QuickLang): ExampleFilter | undefined {
  const draft = parseQuickInput(text, {
    today, nowMinutes: 0, dayStart: 0, dayEnd: MINUTES_IN_DAY_FULL, lang: quickLang,
  });
  const choice = draft.error ? undefined : EXAMPLE_KINDS[draft.kind];
  if (!choice) return undefined;
  const isMetric = draft.kind === 'metric' || draft.kind === 'water';
  const lead = isMetric ? text.trim().split(/\s+/)[0].toLowerCase() : undefined;
  return { choice, kinds: [draft.kind], lead };
}

// Ввод текстом (spec 017): строка → черновик записи, распознанное видно чипами под полем
const PlannerQuickInput = ({
  isOpen, initialText, today, settings, userId, learnedWords, isLearnedSynced, quickLines, tasks, events, onCreated,
  onMore, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();
  const suggestionsRef = useRef<HTMLDivElement>();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<KindChoice>('auto');
  // Окно открыто кнопкой вида («+ Спорт», «Записать сон», значение показателя): пример — подсказкой в пустом
  // поле, вид выбран, подсказки — этого вида
  const [examplePlaceholder, setExamplePlaceholder] = useState<string>();
  const [exampleFilter, setExampleFilter] = useState<ExampleFilter>();
  const [skip, setSkip] = useState<QuickField[]>([]);
  // Чтения, выбранные из вариантов чипа, и чип, у которого варианты сейчас показаны
  const [pick, setPick] = useState<QuickPick>({});
  const [altField, setAltField] = useState<QuickAltField | undefined>();
  // История набранных строк — в данных «Плана»; запасная запись устройства лежит в его хранилище, а не в
  // состоянии: «Забыть» правит её и просит перечитать
  const [historyVersion, setHistoryVersion] = useState(0);
  const [isSuggestionFocused, markSuggestionFocused, unmarkSuggestionFocused] = useFlag();
  // Словарь правок читается в момент открытия окна, а не кадром позже: иначе первый разбор шёл бы по
  // словарю прошлого открытия (например, уже сброшенному в настройках). Источник — данные «Плана» вместе
  // с ещё не перенесённой записью устройства; пока «План» недоступен — только запись устройства
  const learnStore = useMemo<LearnStore | undefined>(() => {
    if (!isOpen) return undefined;
    const local = readLearned(userId);
    return isLearnedSynced ? mergeLearnStores(learnStoreFromWords(learnedWords), local) : local;
  }, [isOpen, userId, isLearnedSynced, learnedWords]);

  const lang = useLang();
  const learned = useMemo(() => learnStore && learnedDefaults(learnStore), [learnStore]);

  // Строку успели набрать до эффекта открытия (быстрый набор, вставка): эффект её не затирает
  const typedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      // Закрытое окно не хранит прежнюю строку: иначе при следующем открытии она мелькнёт на кадр
      typedRef.current = false;
      setText('');
      setExamplePlaceholder(undefined);
      return undefined;
    }
    // Начало строки («задача сегодня ») — в поле; готовый пример вида — подсказкой, поле пустое
    const quickLang = getQuickLang(lang.code);
    const isExample = Boolean(initialText) && !initialText.endsWith(' ');
    const example = isExample ? exampleFilterOf(initialText, today, quickLang) : undefined;
    if (!typedRef.current) setText(example ? '' : initialText || '');
    setExamplePlaceholder(example ? initialText : undefined);
    setExampleFilter(example);
    setChoice(example?.choice || 'auto');
    setSkip([]);
    setPick({});
    setAltField(undefined);
    unmarkSuggestionFocused();
    // Поле появляется вместе с окном: фокус — после его показа
    const timeout = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [isOpen, initialText, userId, today, lang.code]);

  // Разбор без участия пользователя: с ним сравнивается добавленная запись (словарь правок)
  const baseContext = useLastCallback((): QuickContext => {
    const now = new Date();
    return {
      today,
      nowMinutes: now.getHours() * 60 + now.getMinutes(),
      dayStart: settings.dayStart,
      dayEnd: settings.dayEnd,
      lang: getQuickLang(lang.code),
    };
  });

  const parse = useLastCallback((value: string) => parseQuickInput(value, {
    ...baseContext(),
    kind: choice === 'auto' ? undefined : choice,
    skip,
    pick,
    learned,
  }));

  // Черновик — по строке и выбору пользователя; при закрытом окне не разбирается (пока окно уходит, показан
  // прежний)
  const draftRef = useRef<QuickDraft>();
  const draft = useMemo(() => {
    if (isOpen || !draftRef.current) draftRef.current = parse(text);
    return draftRef.current;
    // `parse` читает ровно эти значения
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [isOpen, text, choice, skip, pick, learned, today, settings, lang]);
  const chips = useMemo(() => buildChips(lang, draft), [lang, draft]);
  const hasText = Boolean(text.trim());
  const isNameTooLong = draft.name.length > NAME_MAX_LENGTH;
  const errorKey = !hasText || !draft.error ? undefined
    : EVENT_ERROR_KEYS[draft.error as keyof typeof EVENT_ERROR_KEYS]
      || TASK_ERROR_KEYS[draft.error as keyof typeof TASK_ERROR_KEYS];
  const canSubmit = hasText && !draft.error && !isNameTooLong;
  const isKindLearned = Boolean(draft.learned?.includes('kind'));
  const altsOf = (field: QuickField) => draft.alternatives?.filter((alt) => alt.field === field) || [];
  const kindLabel = draft.metric ? lang(METRIC_LABELS[draft.metric]) : lang(DRAFT_KIND_LABELS[draft.kind]);
  const shownAlts = altField ? altsOf(altField) : [];

  // Подпись чипа: с другими чтениями — кнопка, раскрывающая их
  function renderChipLabel(field: QuickField, label: string) {
    if (!altsOf(field).length) return label;
    return (
      <button
        type="button"
        className={styles.tagAlt}
        data-quick-alt-toggle={field}
        data-field={field}
        aria-haspopup="menu"
        aria-expanded={altField === field}
        title={lang('PlannerQuickAlternatives')}
        onClick={handleAltToggle}
      >
        {label}
        <Icon name="down" />
      </button>
    );
  }

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    typedRef.current = true;
    setText(e.currentTarget.value);
    // Правка строки возвращает снятые значения и выбранные чтения: слова могли измениться
    if (skip.length) setSkip([]);
    if (Object.keys(pick).length) setPick({});
    setAltField(undefined);
  });

  const handleSubmit = useLastCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    // Enter может прийти раньше перерисовки: черновик берётся из самого поля, а не из показанного
    const value = inputRef.current?.value ?? text;
    const entry = parse(value);
    if (!value.trim() || entry.error || entry.name.length > NAME_MAX_LENGTH) return;
    // Правка угаданного типа либо длительности запоминается за первым словом названия
    const auto = parseQuickInput(value, baseContext());
    const local = readLearned(userId);
    // Состояние «Плана» берётся в момент записи: окно могло открыться раньше, чем он стал доступен
    const isSynced = canSyncLearned();
    if (!isSynced) {
      const corrected = recordCorrection(local, auto, entry);
      if (corrected !== local) saveLearned(userId, corrected);
    }
    // Строка запоминается: она станет подсказкой в этом окне — на всех устройствах, если «План» ведёт
    // историю, иначе на этом
    const localHistory = readHistory(userId);
    const isHistorySynced = canSyncQuickHistory();
    const historyKey = lineKey(value, entry, baseContext().lang!);
    if (!isHistorySynced) saveHistory(userId, recordHistoryLine(localHistory, value, historyKey));
    updatePlanner((state) => {
      applyQuickDraft(state, entry, today);
      // Правка словаря — в той же правке «Плана», что и запись: одна операция, одна отмена
      const words = isSynced ? correctWords(state.learned, local, auto, entry) : undefined;
      if (words) state.learned = words;
      // Строка истории — тоже: «Отменить» убирает запись вместе с её подсказкой
      if (isHistorySynced) state.quickLines = recordQuickLine(state.quickLines, localHistory, value, historyKey);
    }, entry.kind === 'goal' ? lang('PlannerNoticeGoalsSaved')
      : lang('PlannerNoticeAdded', { name: entry.name || value.trim() }));
    // Запись устройства влита в «План» той же правкой
    if (isSynced && hasLearned(local)) resetLearned(userId);
    if (isHistorySynced && hasHistory(localHistory)) resetHistory(userId);
    onCreated(entry.day);
  });

  // Окно перехватывает Enter раньше формы — добавляем по клавише в самом поле
  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleSubmit();
  });

  const handleSkip = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setSkip([...skip, e.currentTarget.dataset.field as QuickField]);
    setAltField(undefined);
    inputRef.current?.focus();
  });

  // Чип с другими чтениями раскрывает их список
  const handleAltToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const field = e.currentTarget.dataset.field as QuickAltField;
    setAltField(altField === field ? undefined : field);
  });

  // Выбранное чтение закрепляется: строка разбирается заново с ним
  const handleAlt = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { field, pick: value } = e.currentTarget.dataset as { field: QuickAltField; pick: string };
    if (field === 'kind') {
      setChoice(value as KindChoice);
    } else if (field === 'repeat' && value === QUICK_REPEAT_END) {
      setPick({ ...pick, repeat: undefined });
    } else {
      setPick({ ...pick, [field]: value });
    }
    setAltField(undefined);
    inputRef.current?.focus();
  });

  const handleSubmitClick = useLastCallback(() => handleSubmit());

  // Примеры — на языке интерфейса: их разбирает словарь того же языка
  const examples = useMemo(() => lang('PlannerQuickExamples').split(/\s*\|\s*/).filter(Boolean), [lang]);
  // Кандидаты собираются при открытии окна (каждая строка проходит разбор), набор текста их только фильтрует.
  // Данные «Плана» без изменений приходят теми же объектами (C1), поэтому перечитка состояния список не
  // пересобирает; разбор строк кэширует `buildCandidates`. Небольшие данные собираются сразу; большие —
  // сначала примеры, полный список — когда окно показано и браузер свободен
  const sources = useMemo(() => {
    if (!isOpen) return undefined;
    // История из данных «Плана» вместе с ещё не перенесённой записью устройства; «План» её не ведёт —
    // только запись устройства
    const local = readHistory(userId);
    const history = quickLines ? mergeHistories(historyFromLines(quickLines), local) : local;
    return {
      sources: {
        history, tasks, events, examples,
      },
      ctx: { ...baseContext(), learned },
      isHeavy: history.lines.length + tasks.length + events.length > SYNC_CANDIDATES_LIMIT,
    };
    // Номер правки истории — зависимость: запись устройства лежит в его хранилище, а не в состоянии
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [isOpen, userId, quickLines, tasks, events, examples, learned, historyVersion]);
  const quickCandidates = useMemo(() => {
    if (!sources) return undefined;
    return sources.isHeavy
      ? buildCandidates({
        ...sources.sources, history: EMPTY_HISTORY, tasks: [], events: [],
      }, sources.ctx)
      : buildCandidates(sources.sources, sources.ctx);
  }, [sources]);
  const [idleCandidates, setIdleCandidates] = useState<QuickCandidate[] | undefined>();
  useEffect(() => {
    setIdleCandidates(undefined);
    if (!sources?.isHeavy) return undefined;
    let isStale = false;
    onFullyIdle(() => {
      if (!isStale) setIdleCandidates(buildCandidates(sources.sources, sources.ctx));
    });
    return () => {
      isStale = true;
    };
  }, [sources]);
  const candidates = idleCandidates || quickCandidates;
  const suggestions = useMemo(() => {
    if (!candidates) return [];
    // Пример показателя сужает подсказки до него, пока вид окна не сменён вручную
    const filter = exampleFilter && exampleFilter.choice === choice ? exampleFilter : undefined;
    const pool = filter?.lead ? candidates.filter(({ line }) => line.startsWith(filter.lead!)) : candidates;
    return filterSuggestions(text, pool, undefined, filter?.kinds || CHOICE_KINDS[choice]);
  }, [candidates, text, choice, exampleFilter]);
  const hasExamples = suggestions.some(({ source }) => source === 'example');
  const hasOwnSuggestions = suggestions.some(({ source }) => source !== 'example');

  const handleChoice = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setChoice(e.currentTarget.dataset.kind as KindChoice);
    inputRef.current?.focus();
  });

  // Подсказка заполняет строку: день и время пользователь правит сам, запись добавляет «Добавить»
  const fillInput = useLastCallback((value: string) => {
    setText(value);
    setSkip([]);
    setPick({});
    setAltField(undefined);
    inputRef.current?.focus();
  });

  const handleSuggestion = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    fillInput(e.currentTarget.dataset.text!);
  });

  const handleForget = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const line = e.currentTarget.dataset.text!;
    const candidate = candidates!.find((item) => item.text === line)!;
    const local = readHistory(userId);
    if (canSyncQuickHistory()) {
      // Забытое уходит со всех устройств; запись устройства влита той же правкой
      updatePlanner((state) => {
        state.quickLines = forgetQuickLine(state.quickLines, local, candidate);
      });
      if (hasHistory(local)) resetHistory(userId);
    } else {
      saveHistory(userId, forgetSuggestion(local, candidate));
    }
    setHistoryVersion(historyVersion + 1);
    inputRef.current?.focus();
  });

  // Стрелки: из поля — в подсказки и по ним по кругу. Окно и ловушка фокуса слушают клавиши на документе,
  // поэтому и эти слушатели стоят там же: `false` — клавиша не наша
  const moveSuggestionFocus = useLastCallback((e: KeyboardEvent, delta: 1 | -1) => {
    if (!suggestions.length) return false;
    const items = Array.from(suggestionsRef.current!.querySelectorAll<HTMLElement>(SUGGESTION_SELECTOR));
    const index = items.findIndex((item) => item === document.activeElement);
    const isFromInput = document.activeElement === inputRef.current && delta > 0;
    if (!items.length || (index < 0 && !isFromInput)) return false;
    e.preventDefault();
    items[(index + delta + items.length) % items.length].focus();
    return true;
  });

  // Tab дописывает строку до первой подсказки, когда набрано её начало; иначе — обычный переход фокуса
  const handleTab = useLastCallback((e: KeyboardEvent) => {
    const [top] = suggestions;
    const value = inputRef.current?.value ?? text;
    const isAccepted = !e.shiftKey && document.activeElement === inputRef.current && top
      && isSuggestionPrefix(value, top.text);
    if (!isAccepted) return false;
    e.preventDefault();
    fillInput(top.text);
    return true;
  });

  useEffect(() => (isOpen ? captureKeyboardListeners({
    onDown: (e) => moveSuggestionFocus(e, 1),
    onUp: (e) => moveSuggestionFocus(e, -1),
    onTab: handleTab,
  }) : undefined), [isOpen]);

  // Escape на подсказке возвращает в поле; окно закрывает уже следующий Escape. Слушатель ставится позже
  // слушателя окна (пока подсказка в фокусе) и потому получает клавишу первым
  useEffect(() => (isOpen && isSuggestionFocused ? captureEscKeyListener(() => {
    inputRef.current?.focus();
  }) : undefined), [isOpen, isSuggestionFocused]);

  return (
    <Modal
      isOpen={isOpen}
      title={lang('PlannerQuickTitle')}
      className={styles.quick}
      hasCloseButton
      onClose={onClose}
    >
      <form className={styles.quickForm} data-quick-kind={draft.kind} onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          id="planner-quick-input"
          className={styles.quickInput}
          type="text"
          value={text}
          maxLength={INPUT_MAX_LENGTH}
          placeholder={examplePlaceholder || lang('PlannerQuickPlaceholder')}
          aria-label={lang('PlannerQuickTitle')}
          autoComplete="off"
          enterKeyHint="done"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <div className={styles.quickPreview} aria-live="polite">
          {hasText ? (
            <>
              <span
                className={buildClassName(styles.tag, styles.tagLarge, KIND_CLASSES[draft.kind])}
                data-quick-chip={isKindLearned ? 'kind' : undefined}
                data-learned={isKindLearned ? '1' : undefined}
                title={isKindLearned ? lang('PlannerQuickLearned') : undefined}
              >
                <Icon name={KIND_ICONS[draft.kind]} />
                {renderChipLabel('kind', kindLabel)}
                {isKindLearned && <span className={styles.tagLearned} aria-hidden />}
                {isKindLearned && (
                  <button
                    type="button"
                    className={styles.tagRemove}
                    data-field="kind"
                    aria-label={lang('PlannerQuickRemove', { value: kindLabel })}
                    onClick={handleSkip}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </span>
              {chips.map(({
                field, text: label, isFixed, isLearned, key,
              }) => (
                <span
                  key={key || field}
                  className={buildClassName(styles.tag, styles.tagLarge, styles.kindMuted)}
                  data-quick-chip={field}
                  data-learned={isLearned ? '1' : undefined}
                  title={isLearned ? lang('PlannerQuickLearned') : undefined}
                >
                  {renderChipLabel(field, label)}
                  {isLearned && <span className={styles.tagLearned} aria-hidden />}
                  {!isFixed && (
                    <button
                      type="button"
                      className={styles.tagRemove}
                      data-field={field}
                      aria-label={lang('PlannerQuickRemove', { value: label })}
                      onClick={handleSkip}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </span>
              ))}
              {Boolean(shownAlts.length) && (
                <div className={styles.quickAlts} role="menu" data-quick-alts={altField}>
                  <span className={styles.quickPartLabel}>{lang('PlannerQuickAlternatives')}</span>
                  {shownAlts.map((alt) => (
                    <button
                      key={alt.pick}
                      type="button"
                      role="menuitem"
                      className={styles.chip}
                      data-quick-alt={alt.pick}
                      data-field={alt.field}
                      data-pick={alt.pick}
                      onClick={handleAlt}
                    >
                      {formatAlt(lang, draft, alt)}
                    </button>
                  ))}
                </div>
              )}
              {draft.kind === 'task' || draft.kind === 'event' ? (
                <div className={styles.quickParts}>
                  <div className={styles.quickPart} data-quick-part="name">
                    <span className={styles.quickPartLabel}>{lang('PlannerQuickName')}</span>
                    <span className={buildClassName(styles.quickPartText, styles.quickPartName)} dir="auto">
                      {draft.name || lang('PlannerQuickNoName')}
                    </span>
                  </div>
                  {draft.description && (
                    <div className={styles.quickPart} data-quick-part="description" data-quick-chip="description">
                      <span className={styles.quickPartLabel}>{lang('PlannerFieldDescription')}</span>
                      <span className={styles.quickPartText} dir="auto">{draft.description}</span>
                      <button
                        type="button"
                        className={styles.tagRemove}
                        data-field="description"
                        aria-label={lang('PlannerQuickRemove', { value: lang('PlannerFieldDescription') })}
                        title={lang('PlannerQuickDescriptionToName')}
                        onClick={handleSkip}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className={styles.quickName} dir="auto">
                  {draft.name || (draft.metric && lang(METRIC_LABELS[draft.metric]))
                    || (draft.kind === 'sleep' && lang('PlannerKindSleep'))
                    || (draft.kind === 'water' && lang('PlannerHealthWater'))
                    || (draft.kind === 'goal' && lang('PlannerHealthGoals')) || lang('PlannerQuickNoName')}
                </div>
              )}
              {errorKey && <div className={styles.quickError} role="alert">{lang(errorKey)}</div>}
              {isNameTooLong && <div className={styles.quickError} role="alert">{lang('PlannerQuickTooLong')}</div>}
            </>
          ) : (
            <span className={styles.muted}>{lang('PlannerQuickHint')}</span>
          )}
        </div>
        <div className={buildClassName(styles.hscroll, 'no-scrollbar')} role="radiogroup">
          {KIND_CHOICES.map((kind) => {
            const isActive = choice === kind
              || (choice === 'auto' && hasText && (CHOICE_OF[draft.kind] || draft.kind) === kind);
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={choice === kind}
                data-kind={kind}
                className={buildClassName(
                  styles.chip, kind !== 'auto' && KIND_CLASSES[kind], isActive && styles.chipOn,
                )}
                onClick={handleChoice}
              >
                {lang(KIND_LABELS[kind])}
              </button>
            );
          })}
        </div>
        {Boolean(suggestions.length) && (
          <div data-quick-suggestions>
            <div className={styles.sheetHint}>
              {lang(!hasExamples ? 'PlannerQuickRecentTitle'
                : hasOwnSuggestions ? 'PlannerQuickSuggestionsTitle' : 'PlannerQuickExamplesTitle')}
            </div>
            <div ref={suggestionsRef} className={buildClassName(styles.quickSuggestions, 'no-scrollbar')}>
              {suggestions.map(({ text: line, source }) => (
                <span key={line} className={styles.quickSuggestion}>
                  <button
                    type="button"
                    className={styles.quickSuggestionText}
                    data-quick-suggestion
                    data-source={source}
                    data-text={line}
                    onClick={handleSuggestion}
                    onFocus={markSuggestionFocused}
                    onBlur={unmarkSuggestionFocused}
                  >
                    {line}
                  </button>
                  {source !== 'example' && (
                    <button
                      type="button"
                      className={styles.tagRemove}
                      data-quick-suggestion-forget
                      data-text={line}
                      aria-label={lang('PlannerQuickForget', { value: line })}
                      title={lang('PlannerQuickForget', { value: line })}
                      onClick={handleForget}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className={styles.quickFooter}>
          <span className={buildClassName(styles.muted, styles.grow)}>
            {lang('PlannerQuickDefault', { date: formatDayLabel(lang, today) })}
          </span>
          {onMore && (
            <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onMore}>
              {lang('PlannerQuickMore')}
            </button>
          )}
          <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onClose}>
            {lang('Cancel')}
          </button>
          <button
            type="button"
            className={buildClassName(styles.btn, styles.btnAccent)}
            disabled={!canSubmit}
            onClick={handleSubmitClick}
          >
            {lang('PlannerAdd')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// Подпись другого чтения — так же, как его показал бы чип
function formatAlt(lang: ReturnType<typeof useLang>, draft: QuickDraft, alt: QuickAlt) {
  switch (alt.field) {
    case 'kind':
      return lang(DRAFT_KIND_LABELS[alt.pick as QuickKind]);
    case 'time':
      return alt.pick.replace('-', '–');
    case 'day':
      return formatDay(lang, alt.pick);
    case 'due':
      return lang('PlannerQuickDue', { date: formatDay(lang, alt.pick) });
    default:
      // Повтор: ряд без конца («до <дата>» — слова названия) либо снова с концом
      return draft.repeat ? formatRepeat(lang, {
        ...draft.repeat, endDay: alt.pick === QUICK_REPEAT_END ? alt.day : undefined,
      }) : alt.pick;
  }
}

const TIME_GOAL_KEYS = new Set(['bedtime', 'wakeTime']);

function buildChips(lang: ReturnType<typeof useLang>, draft: QuickDraft): Chip[] {
  const has = (field: QuickField) => draft.spans.some((span) => span.field === field);
  const chips: Chip[] = [];
  const fixed = (field: QuickField, text: string) => chips.push({ field, text, isFixed: true });
  const number = (value: number) => lang.number(value);
  if (draft.kind === 'goal') {
    const changes = draft.goalChanges!;
    Object.entries(changes.goals).forEach(([metric, value]) => fixed('health', `${metric} → ${number(value)}`));
    // Цель режима сна — минуты от полуночи: показываются временем
    Object.entries(changes.health).forEach(([key, value]) => fixed(
      'health', `${key} → ${TIME_GOAL_KEYS.has(key) ? toTime(value) : number(value)}`,
    ));
    if (changes.dayStart !== undefined) {
      fixed('time', `${toTime(changes.dayStart)}–${toTime(changes.dayEnd!)}`);
    }
    if (changes.budget) fixed('minutes', formatDuration(lang, changes.budget));
    return chips.map((chip, index) => ({ ...chip, key: `${chip.field}${index}` }));
  }
  if (draft.kind === 'metric') {
    if (draft.value !== undefined) {
      fixed('health', draft.value2 ? `${draft.value}/${draft.value2}` : number(draft.value));
    }
    return chips;
  }
  if (draft.kind === 'water') {
    if (draft.waterMl) fixed('water', lang('PlannerHealthMl', { value: draft.waterMl }));
    return chips;
  }
  if (draft.kind === 'sleep') {
    if (draft.start && draft.end) fixed('time', `${draft.start}–${draft.end}`);
    if (draft.minutes) fixed('minutes', formatSpan(draft.minutes));
    return chips;
  }
  if (draft.repeat) {
    chips.push({ field: 'repeat', text: formatRepeat(lang, draft.repeat) });
  } else if (draft.day) {
    chips.push({ field: 'day', text: formatDay(lang, draft.day), isFixed: draft.isDayAssumed || !has('day') });
  }
  if (draft.kind === 'food') {
    const nutrients = draft.nutrients || {};
    if (draft.meal) fixed('meal', lang(MEAL_LABELS[draft.meal]));
    if (nutrients.kcal !== undefined) fixed('kcal', lang('PlannerHealthKcal', { value: number(nutrients.kcal) }));
    if (nutrients.protein !== undefined || nutrients.fat !== undefined || nutrients.carbs !== undefined) {
      fixed('protein', lang('PlannerHealthMacros', {
        protein: number(nutrients.protein || 0), fat: number(nutrients.fat || 0), carbs: number(nutrients.carbs || 0),
      }));
    }
    if (nutrients.fiber !== undefined) {
      fixed('fiber', lang('PlannerHealthFiberShort', { value: number(nutrients.fiber) }));
    }
    if (draft.grams) fixed('grams', lang('PlannerHealthGramsNoGoal', { value: number(draft.grams) }));
    return chips;
  }
  if (draft.kind === 'workout') {
    if (draft.start) fixed('time', draft.start);
    if (draft.minutes) fixed('minutes', formatDuration(lang, draft.minutes));
    if (draft.distanceKm) {
      const pace = formatPace(draft.minutes || 0, draft.distanceKm);
      fixed('health', [
        lang('PlannerHealthKm', { value: number(draft.distanceKm) }),
        pace && lang('PlannerHealthPace', { value: pace }),
      ].filter(Boolean).join(' · '));
    }
    if (draft.exercises) fixed('grams', lang('PlannerQuickWorkoutSets', { count: draft.exercises.length }));
    return chips;
  }
  if (draft.isAllDay) chips.push({ field: 'time', text: lang('PlannerAllDayShort'), isFixed: true });
  else if (draft.start) {
    chips.push({ field: 'time', text: draft.end ? `${draft.start}–${draft.end}` : draft.start });
  }
  if (draft.minutes && (draft.kind === 'task' || !draft.end)) {
    chips.push({ field: 'minutes', text: formatDuration(lang, draft.minutes), isFixed: !has('minutes') });
  }
  // Длительность из словаря правок — своим чипом: его снятие возвращает обычную
  if (draft.learned?.includes('minutes') && draft.start && draft.end) {
    chips.push({
      field: 'minutes',
      text: formatDuration(lang, toMinutes(draft.end) - toMinutes(draft.start)),
      isLearned: true,
    });
  }
  if (draft.due) chips.push({ field: 'due', text: lang('PlannerQuickDue', { date: formatDay(lang, draft.due) }) });
  if (draft.list) chips.push({ field: 'list', text: `#${draft.list}` });
  if (draft.place) chips.push({ field: 'place', text: `@${draft.place}` });
  if (draft.isImportant) chips.push({ field: 'important', text: `! ${lang('PlannerStatusActive')}` });
  if (draft.remind !== undefined) chips.push({ field: 'remind', text: formatRemind(lang, draft.remind) });
  return chips;
}

export default memo(PlannerQuickInput);
