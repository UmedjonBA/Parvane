import {
  memo, onFullyIdle, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { IconName } from '../../../types/icons';
import type {
  PlannerEvent, PlannerLearnedWord, PlannerQuickLine, PlannerSettings, PlannerTask,
} from './plannerModel';
import type {
  QuickAlt, QuickAltField, QuickContext, QuickDraft, QuickField, QuickKind, QuickPick,
} from './plannerQuick';
import type { LearnStore } from './plannerQuickLearn';
import type { QuickCandidate, QuickHistory } from './plannerQuickSuggest';
import type { QuickChoice, QuickHealthKind } from './quickKinds';

import { IS_MAC_OS } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import captureKeyboardListeners from '../../../util/captureKeyboardListeners';
import { getIsModuleOn } from '../../../util/parvaneModules';
import { openNote } from '../../../util/parvaneSection';
import { MODULE_TITLE_KEYS } from '../../main/parvaneModuleNav';
import { addHealthEntries, parseHealthInput } from '../health/healthStore';
import useHealthParse, { isWholeHealthLine } from '../health/useHealthParse';
import {
  formatDay, formatDuration, formatRemind, formatRepeat,
} from './plannerFormat';
import { toMinutes } from './plannerModel';
import { getQuickLang, parseQuickInput, QUICK_REPEAT_END } from './plannerQuick';
import { applyQuickDraft } from './plannerQuickApply';
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
import {
  isHealthChoice, isPlanChoice, listQuickChoices, pickHealthParse,
} from './quickKinds';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import Icon from '../../common/icons/Icon';
import Modal from '../../ui/Modal';
import HealthUnderstood from '../health/HealthUnderstood';
import { EVENT_ERROR_KEYS, TASK_ERROR_KEYS } from './PlannerTaskForm';

import styles from './Planner.module.scss';
import extra from './PlannerQuickExtras.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Строка, с которой окно открывается («задача сегодня », «обед »)
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

type KindChoice = QuickChoice;
type Chip = {
  field: QuickField;
  text: string;
  isFixed?: boolean;
  // Значение подставлено из словаря правок: снятый чип возвращает обычное
  isLearned?: boolean;
};

const KIND_LABELS = {
  auto: 'PlannerQuickAuto',
  event: 'PlannerKindEvent',
  task: 'PlannerKindTask',
  sleep: 'HealthKindSleep',
  weight: 'HealthKindWeight',
  pressure: 'HealthKindPressure',
  pulse: 'HealthKindPulse',
  steps: 'HealthKindSteps',
  mood: 'HealthKindMood',
  note: 'PvQuickKindNote',
} as const satisfies Record<KindChoice, string>;
// Строка выбранного вида «Здоровья» со словом вида: «72» при виде «Вес» — «вес 72»
const HEALTH_WORD_KEYS = {
  sleep: 'PvQuickAsSleep',
  weight: 'PvQuickAsWeight',
  pressure: 'PvQuickAsPressure',
  pulse: 'PvQuickAsPulse',
  steps: 'PvQuickAsSteps',
  mood: 'PvQuickAsMood',
} as const satisfies Record<QuickHealthKind, string>;
const KIND_CLASSES = {
  event: styles.kindEvent,
  task: styles.kindTask,
} satisfies Record<QuickKind, string>;
const KIND_ICONS = {
  event: 'calendar',
  task: 'check',
} as const satisfies Record<QuickKind, IconName>;
const NAME_MAX_LENGTH = 160;
const INPUT_MAX_LENGTH = 300;
const FOCUS_DELAY_MS = 200;
const SUGGESTION_SELECTOR = '[data-quick-suggestion]';
// Столько строк истории и записей «Плана» разбираются сразу при открытии; больше — сначала показываются
// примеры, полный список собирается, когда окно показано и браузер свободен
const SYNC_CANDIDATES_LIMIT = 120;
const EMPTY_HISTORY: QuickHistory = { tick: 0, lines: [], hidden: [] };

// Ввод текстом (spec 017): строка → черновик записи, распознанное видно чипами под полем. Строку параллельно
// разбирает движок «Здоровья»: понятая им целиком («вес 72,4», «обед гречка 650 ккал») уходит в модуль
// «Здоровье», остальное — задача либо событие «Плана»
const PlannerQuickInput = ({
  isOpen, initialText, today, settings, userId, learnedWords, isLearnedSynced, quickLines, tasks, events, onCreated,
  onMore, onClose,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const suggestionsRef = useRef<HTMLDivElement>();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<KindChoice>('auto');
  const { enabled: enabledModules, prefs: modulePrefs } = useParvaneModules();
  const isPlanOn = enabledModules.includes('plan');
  const kindChoices = useMemo(() => listQuickChoices({
    isPlanOn,
    isHealthOn: enabledModules.includes('health'),
    isNotesOn: enabledModules.includes('notes'),
  }, modulePrefs.healthBlocks), [isPlanOn, enabledModules, modulePrefs.healthBlocks]);
  // Строка «Здоровья»: модуль включён и вид не выбран вручную (движок понял строку целиком) либо выбран вид
  // «Здоровья» (строка понята как этот вид — как есть либо со словом вида)
  const healthChoice = isHealthChoice(choice) ? choice : undefined;
  const canBeHealth = isOpen && (choice === 'auto' || Boolean(healthChoice)) && getIsModuleOn('health');
  const { parsed: healthParsed, isCurrent: isHealthCurrent } = useHealthParse(text, !canBeHealth);
  const wordText = healthChoice && text.trim() ? lang(HEALTH_WORD_KEYS[healthChoice], { text: text.trim() }) : '';
  const { parsed: wordParsed, isCurrent: isWordCurrent } = useHealthParse(wordText, !canBeHealth || !healthChoice);
  const healthLine = !isHealthCurrent || !healthParsed ? undefined
    : healthChoice ? (isWordCurrent ? pickHealthParse(healthChoice, healthParsed, wordParsed) : undefined)
      : isWholeHealthLine(healthParsed) ? healthParsed : undefined;
  const [hasHealthFailed, setHasHealthFailed] = useState(false);
  const isSubmittingRef = useRef(false);
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
  // «Запоминать мои правки» выключено в настройках — выученное не подставляется и правки не запоминаются
  const isLearnOff = Boolean(settings.isLearnOff);
  const learnStore = useMemo<LearnStore | undefined>(() => {
    if (!isOpen || isLearnOff) return undefined;
    const local = readLearned(userId);
    return isLearnedSynced ? mergeLearnStores(learnStoreFromWords(learnedWords), local) : local;
  }, [isOpen, isLearnOff, userId, isLearnedSynced, learnedWords]);

  const learned = useMemo(() => learnStore && learnedDefaults(learnStore), [learnStore]);

  // Строку успели набрать до эффекта открытия (быстрый набор, вставка): эффект её не затирает
  const typedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      // Закрытое окно не хранит прежнюю строку: иначе при следующем открытии она мелькнёт на кадр
      typedRef.current = false;
      setText('');
      return undefined;
    }
    if (!typedRef.current) setText(initialText || '');
    setChoice('auto');
    setHasHealthFailed(false);
    setSkip([]);
    setPick({});
    setAltField(undefined);
    unmarkSuggestionFocused();
    // Поле появляется вместе с окном: фокус — после его показа
    const timeout = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [isOpen, initialText, userId]);

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
    kind: isPlanChoice(choice) ? choice : undefined,
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
  const isNoteChoice = choice === 'note';
  // Вид «Здоровья» без понятой строки и запись «Плана» при выключенном «Плане» не сохраняются
  const canSubmit = hasText && (Boolean(healthLine) || isNoteChoice
    || (!healthChoice && isPlanOn && !draft.error && !isNameTooLong));
  const isKindLearned = Boolean(draft.learned?.includes('kind'));
  const altsOf = (field: QuickField) => draft.alternatives?.filter((alt) => alt.field === field) || [];
  const kindLabel = lang(KIND_LABELS[draft.kind]);
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
    setHasHealthFailed(false);
    // Правка строки возвращает снятые значения и выбранные чтения: слова могли измениться
    if (skip.length) setSkip([]);
    if (Object.keys(pick).length) setPick({});
    setAltField(undefined);
  });

  const handleSubmit = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    // Enter может прийти раньше перерисовки: строка берётся из самого поля, а не из показанного
    const value = inputRef.current?.value ?? text;
    if (!value.trim() || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      if (choice === 'note') {
        // Вид «Заметка»: строка — название новой заметки, она и откроется
        openNote(value.trim());
        onCreated();
      } else if (!await saveHealthLine(value) && isPlanOn) {
        savePlannerEntry(value);
      }
    } finally {
      isSubmittingRef.current = false;
    }
  });

  // «Здоровье» — отдельный модуль (spec 041): строка, понятая его движком целиком, пишется в его контейнер,
  // календарь «Плана» читает её оттуда. `true` — строка была строкой «Здоровья» (записана либо показана ошибка)
  const saveHealthLine = useLastCallback(async (value: string) => {
    if ((choice !== 'auto' && !healthChoice) || !getIsModuleOn('health')) return false;
    // Разбирается именно эта строка: показанный разбор мог относиться к прежней
    const plain = await parseHealthInput(value);
    const parsed = healthChoice
      ? pickHealthParse(healthChoice, plain, await parseHealthInput(lang(HEALTH_WORD_KEYS[healthChoice], {
        text: value.trim(),
      })))
      : plain && isWholeHealthLine(plain) ? plain : undefined;
    // Выбран вид «Здоровья», а строка им не понята — в «План» она не уходит
    if (!parsed) return Boolean(healthChoice);
    if (await addHealthEntries(parsed.entries)) {
      const [first] = parsed.entries;
      onCreated(first.endDay || first.day);
    } else {
      setHasHealthFailed(true);
    }
    return true;
  });

  const savePlannerEntry = useLastCallback((value: string) => {
    const entry = parse(value);
    if (entry.error || entry.name.length > NAME_MAX_LENGTH) return;
    // Правка угаданного типа либо длительности запоминается за первым словом названия
    const auto = parseQuickInput(value, baseContext());
    const local = readLearned(userId);
    // Состояние «Плана» берётся в момент записи: окно могло открыться раньше, чем он стал доступен
    const isSynced = canSyncLearned();
    if (!isSynced && !isLearnOff) {
      const corrected = recordCorrection(local, auto, entry);
      if (corrected !== local) saveLearned(userId, corrected);
    }
    // Строка запоминается: она станет подсказкой в этом окне — на всех устройствах, если «План» ведёт
    // историю, иначе на этом
    const localHistory = readHistory(userId);
    const isHistorySynced = canSyncQuickHistory();
    const historyKey = lineKey(entry, baseContext().lang!);
    if (!isHistorySynced) saveHistory(userId, recordHistoryLine(localHistory, value, historyKey));
    updatePlanner((state) => {
      applyQuickDraft(state, entry);
      // Правка словаря — в той же правке «Плана», что и запись: одна операция, одна отмена
      const words = isSynced && !isLearnOff ? correctWords(state.learned, local, auto, entry) : undefined;
      if (words) state.learned = words;
      // Строка истории — тоже: «Отменить» убирает запись вместе с её подсказкой
      if (isHistorySynced) state.quickLines = recordQuickLine(state.quickLines, localHistory, value, historyKey);
    }, lang('PlannerNoticeAdded', { name: entry.name || value.trim() }));
    // Запись устройства влита в «План» той же правкой
    if (isSynced && hasLearned(local)) resetLearned(userId);
    if (isHistorySynced && hasHistory(localHistory)) resetHistory(userId);
    onCreated(entry.day);
  });

  // Окно перехватывает Enter раньше формы — добавляем по клавише в самом поле
  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void handleSubmit();
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

  const handleSubmitClick = useLastCallback(() => {
    void handleSubmit();
  });

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
    return filterSuggestions(text, candidates, undefined, isPlanChoice(choice) ? [choice] : undefined);
  }, [candidates, text, choice]);
  const hasExamples = suggestions.some(({ source }) => source === 'example');
  const hasOwnSuggestions = suggestions.some(({ source }) => source !== 'example');

  const handleChoice = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setChoice(e.currentTarget.dataset.kind as KindChoice);
    inputRef.current?.focus();
  });

  // «Другие чтения» у строки «Здоровья» — та же строка записью «Плана»
  const handleOtherReading = useLastCallback(() => {
    setChoice(draft.kind);
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
      title={[lang('PlannerQuickTitle'), <kbd key="hotkey" className={extra.kbd}>{IS_MAC_OS ? '⌘N' : 'Ctrl+N'}</kbd>]}
      className={styles.quick}
      hasCloseButton
      onClose={onClose}
    >
      <form
        className={styles.quickForm}
        data-quick-kind={healthLine || healthChoice ? 'health' : isNoteChoice ? 'note' : draft.kind}
        onSubmit={handleSubmit}
      >
        <input
          ref={inputRef}
          id="planner-quick-input"
          className={styles.quickInput}
          type="text"
          value={text}
          maxLength={INPUT_MAX_LENGTH}
          placeholder={lang('PlannerQuickPlaceholder')}
          aria-label={lang('PlannerQuickTitle')}
          autoComplete="off"
          enterKeyHint="done"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <div className={styles.quickPreview} aria-live="polite">
          {healthLine ? (
            <>
              <HealthUnderstood
                parsed={healthLine}
                withModule
                onAlternatives={choice === 'auto' && isPlanOn ? handleOtherReading : undefined}
              />
              {hasHealthFailed && <div className={styles.quickError} role="alert">{lang('HealthQuickFailed')}</div>}
            </>
          ) : healthChoice && hasText ? (
            <span className={styles.muted} data-quick-not-understood>{lang('PvQuickNotHealth')}</span>
          ) : isNoteChoice && hasText ? (
            <div className={extra.understood} data-quick-understood="note">
              {lang('PvQuickUnderstood', { kind: lang('PvQuickKindNote') })}
              <span className={styles.muted}>
                {' · '}
                {lang('PvQuickInModule', { module: lang(MODULE_TITLE_KEYS.notes) })}
              </span>
              <div className={buildClassName(styles.quickPartText, styles.quickPartName)} dir="auto">{text.trim()}</div>
            </div>
          ) : hasText ? (
            <>
              <div className={extra.understood} data-quick-understood={draft.kind}>
                {lang('PvQuickUnderstood', { kind: kindLabel })}
                <span className={styles.muted}>
                  {' · '}
                  {lang('PvQuickInModule', { module: lang(MODULE_TITLE_KEYS.plan) })}
                </span>
              </div>
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
                field, text: label, isFixed, isLearned,
              }) => (
                <span
                  key={field}
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
              {errorKey && <div className={styles.quickError} role="alert">{lang(errorKey)}</div>}
              {isNameTooLong && <div className={styles.quickError} role="alert">{lang('PlannerQuickTooLong')}</div>}
            </>
          ) : (
            <span className={styles.muted}>{lang('PlannerQuickHint')}</span>
          )}
        </div>
        <div className={buildClassName(styles.hscroll, 'no-scrollbar')} role="radiogroup">
          {kindChoices.map((kind) => {
            const autoKind = healthLine ? healthChoiceOf(healthLine.entries[0].kind) : draft.kind;
            const isActive = choice === kind || (choice === 'auto' && hasText && autoKind === kind);
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={choice === kind}
                data-kind={kind}
                className={buildClassName(
                  styles.chip, isPlanChoice(kind) && KIND_CLASSES[kind], isActive && styles.chipOn,
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
          <span className={buildClassName(styles.muted, styles.grow, extra.hint)}>
            {lang('PvQuickModuleHint')}
          </span>
          {onMore && (
            <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onMore}>
              {lang('PlannerQuickMore')}
            </button>
          )}
          <button
            type="button"
            className={buildClassName(styles.btn, styles.btnAccent)}
            disabled={!canSubmit}
            data-quick-save
            onClick={handleSubmitClick}
          >
            {lang('Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// Вид разбора «Здоровья» → вид выбора окна (отметки «лёг» и «встал» — сон)
function healthChoiceOf(kind: string): KindChoice | undefined {
  if (kind === 'sleep_start' || kind === 'sleep_end') return 'sleep';
  return isHealthChoice(kind as KindChoice) ? kind as KindChoice : undefined;
}

// Подпись другого чтения — так же, как его показал бы чип
function formatAlt(lang: ReturnType<typeof useLang>, draft: QuickDraft, alt: QuickAlt) {
  switch (alt.field) {
    case 'kind':
      return lang(KIND_LABELS[alt.pick as QuickKind]);
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

function buildChips(lang: ReturnType<typeof useLang>, draft: QuickDraft): Chip[] {
  const has = (field: QuickField) => draft.spans.some((span) => span.field === field);
  const chips: Chip[] = [];
  if (draft.repeat) {
    chips.push({ field: 'repeat', text: formatRepeat(lang, draft.repeat) });
  } else if (draft.day) {
    chips.push({ field: 'day', text: formatDay(lang, draft.day), isFixed: draft.isDayAssumed || !has('day') });
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
