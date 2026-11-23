import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '@teact';
import { getActions } from '../../../global';

import type { HealthBlockId, ParvaneModuleId, ParvaneModuleState } from '../../../util/parvaneModules';
import { SettingsScreens } from '../../../types';

import { requestMeasure, requestMutation } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import {
  HEALTH_BLOCK_IDS, moveModule, setHealthBlockOn, setModuleOn,
} from '../../../util/parvaneModules';
import { openFiles } from '../../../util/parvaneSection';
import { MODULE_ICONS, MODULE_TITLE_KEYS } from '../../main/parvaneModuleNav';
import { setCloudPlace } from '../../parvane/cloud/cloudStore';
import { getVaultPlace } from '../../parvane/notes/notesStore';
import { findDropIndex, findKeyMoveIndex } from './modulesDrag';

import useAppLayout from '../../../hooks/useAppLayout';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSwitch from '../../parvane/notes/PvSwitch';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './SettingsModules.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

// Перетаскиваемая строка: какой модуль и где он стоял до начала (там остаётся след «было здесь»)
type DragState = { id: ParvaneModuleId; startIndex: number; pointerId: number };

const HEALTH_BLOCK_TITLE_KEYS = {
  sleep: 'ParvaneHealthBlockSleep',
  body: 'ParvaneHealthBlockBody',
  food: 'ParvaneHealthBlockFood',
  water: 'ParvaneHealthBlockWater',
  workouts: 'ParvaneHealthBlockWorkouts',
} as const satisfies Record<HealthBlockId, string>;

const MODULE_HINT_KEYS = {
  plan: 'ParvaneModulePlanHint',
  notes: 'ParvaneModuleNotesHint',
  files: 'ParvaneModuleFilesHint',
  music: 'ParvaneModuleMusicHint',
} as const;

// Модули со своей страницей настроек: кнопка в строке модуля (доска `Desktop`), атрибут — для сценариев
const SETTINGS_LINK_KEYS = {
  plan: 'PlannerSettings',
  health: 'ParvaneNavGoals',
  notes: 'ParvaneNavStorage',
} as const satisfies Partial<Record<ParvaneModuleId, string>>;

// Строка переезжает на новое место за это время
const ROW_MOVE_MS = 180;

const SETTINGS_LINK_PHONE_KEYS = {
  plan: 'PlannerSettings',
  health: 'HealthGoalsTitle',
  notes: 'ParvaneNavStorage',
} as const satisfies Record<keyof typeof SETTINGS_LINK_KEYS, string>;

// Parvane: «Профиль → Модули» — какие модули показывать и в каком порядке. Настройка этого устройства.
// Порядок меняется перетаскиванием за ручку (мышь и касание — события указателя) и стрелками на ручке;
// лента и панель меняются по ходу перетаскивания. Телефон — доски `Modules`, `XpStart`; компьютер — `Desktop`
const SettingsModules = ({ isActive, onReset }: OwnProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const { isMobile } = useAppLayout();
  const isDesk = !isMobile;
  const { states: modules, prefs } = useParvaneModules();
  const listRef = useRef<HTMLDivElement>();
  const [drag, setDrag] = useState<DragState>();
  // Телефон: подстроки модуля (ссылка настроек, блоки «Здоровья») свёрнуты, касание строки раскрывает их
  const [expandedIds, setExpandedIds] = useState<ParvaneModuleId[]>([]);

  useHistoryBack({ isActive, onBack: onReset });

  const handleToggle = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    setModuleOn(e.currentTarget.dataset.module as ParvaneModuleId, isOn);
  });

  const handleExpandClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.moduleExpand as ParvaneModuleId;
    setExpandedIds((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));
  });

  const handleBlockToggle = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    setHealthBlockOn(e.currentTarget.dataset.block as HealthBlockId, isOn);
  });

  const handleBlockChipClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const block = e.currentTarget.dataset.block as HealthBlockId;
    setHealthBlockOn(block, !prefs.healthBlocks.includes(block));
  });

  // Страницы настроек модуля: «Модули / План», «Модули / Здоровье» (доски `RdPlanSet`, `PhModSettings`);
  // хранилище «Заметок» — его папка в «Файлах»
  const handleOpenSettings = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.moduleSettings as keyof typeof SETTINGS_LINK_KEYS;
    if (id === 'plan') {
      openSettingsScreen({ screen: SettingsScreens.ParvanePlanSettings });
    } else if (id === 'health') {
      openSettingsScreen({ screen: SettingsScreens.ParvaneHealthGoals });
    } else {
      const { vault } = getVaultPlace();
      setCloudPlace(vault ? { folder: vault } : {});
      openFiles();
    }
  });

  // Ручка, переставленная стрелкой: фокус возвращается ей после отрисовки нового порядка — перестановка строк
  // в разметке снимает фокус, а новый порядок приходит позже нажатия
  const focusAfterMoveRef = useRef<ParvaneModuleId>();
  const focusHandle = (id: ParvaneModuleId) => {
    focusAfterMoveRef.current = id;
    requestMutation(() => {
      listRef.current?.querySelector<HTMLButtonElement>(`[data-drag-handle="${id}"]`)?.focus();
    });
  };

  useLayoutEffect(() => {
    const id = focusAfterMoveRef.current;
    if (!id) return;
    focusAfterMoveRef.current = undefined;
    requestMutation(() => {
      listRef.current?.querySelector<HTMLButtonElement>(`[data-drag-handle="${id}"]`)?.focus();
    });
  }, [modules]);

  const handleHandleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.dragHandle as ParvaneModuleId;
    const index = modules.findIndex((module) => module.id === id);
    const target = findKeyMoveIndex(index, e.key, modules.length);
    if (target === undefined) return;
    e.preventDefault();
    moveModule(id, target);
    focusHandle(id);
  });

  // Перетаскивание слушает указатель на всём окне, а не на ручке: строка при перестановке переезжает в разметке, и
  // браузер снимает с ручки захват указателя — без этого касание «зависало» в «отпустите здесь», а остальные ручки
  // больше не нажимались
  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const id = e.currentTarget.dataset.dragHandle as ParvaneModuleId;
    e.preventDefault();
    setDrag({ id, startIndex: modules.findIndex((module) => module.id === id), pointerId: e.pointerId });
  });

  const handlePointerMove = useLastCallback((e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId || !listRef.current) return;
    e.preventDefault();
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-module-row]'));
    const middles = rows
      .filter((row) => row.dataset.moduleRow !== drag.id)
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
    const target = findDropIndex(middles, e.clientY);
    if (modules[target]?.id === drag.id) return;
    rememberRowTops();
    moveModule(drag.id, target);
  });

  const finishDrag = useLastCallback((isCancelled?: boolean) => {
    if (!drag) return;
    if (isCancelled) {
      rememberRowTops();
      moveModule(drag.id, drag.startIndex);
    }
    setDrag(undefined);
  });

  const handlePointerUp = useLastCallback((e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) finishDrag();
  });

  const handlePointerCancel = useLastCallback((e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) finishDrag(true);
  });

  const isDragging = Boolean(drag);
  useEffect(() => {
    if (!isDragging) return undefined;
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [isDragging, handlePointerMove, handlePointerUp, handlePointerCancel]);

  // Строки разъезжаются плавно: места строк до перестановки запоминаются, после отрисовки строка едет со старого
  // места на новое
  const rowTopsRef = useRef<Map<string, number>>();
  function rememberRowTops() {
    const list = listRef.current;
    if (!list) return;
    rowTopsRef.current = new Map(Array.from(list.querySelectorAll<HTMLElement>('[data-module-row]'))
      .map((row) => [row.dataset.moduleRow!, row.getBoundingClientRect().top]));
  }

  useLayoutEffect(() => {
    const before = rowTopsRef.current;
    rowTopsRef.current = undefined;
    if (!before) return;
    requestMeasure(() => {
      const list = listRef.current;
      if (!list) return;
      const shifts = Array.from(list.querySelectorAll<HTMLElement>('[data-module-row]'))
        .map((row) => ({ row, shift: (before.get(row.dataset.moduleRow!) ?? 0) - row.getBoundingClientRect().top }))
        .filter(({ shift }) => Math.abs(shift) > 1);
      requestMutation(() => {
        shifts.forEach(({ row, shift }) => {
          row.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], {
            duration: ROW_MOVE_MS, easing: 'ease-out',
          });
        });
      });
    });
  }, [modules]);

  // Escape посреди перетаскивания возвращает строку на место (и не закрывает экран)
  useLayoutEffect(() => (drag ? captureEscKeyListener(() => finishDrag(true)) : undefined), [drag, finishDrag]);

  function getSubtitle(module: ParvaneModuleState) {
    if (module.isLocked) return lang('ParvaneModuleAlwaysOn');
    if (module.isServerOff) return lang('ParvaneModuleServerOff');
    if (module.isUnavailable) return lang('ParvaneModuleSoon');
    if (!module.isOn) return lang(isDesk ? 'ParvaneNavHiddenInline' : 'ParvaneModuleHidden');
    if (module.id === 'health') {
      if (isDesk && prefs.healthBlocks.length) {
        return HEALTH_BLOCK_IDS.filter((block) => prefs.healthBlocks.includes(block))
          .map((block) => lowerFirst(lang(HEALTH_BLOCK_TITLE_KEYS[block]), lang.code)).join(', ');
      }
      return lang('ParvaneModuleHealthBlocks', { count: prefs.healthBlocks.length, total: HEALTH_BLOCK_IDS.length });
    }
    return lang(MODULE_HINT_KEYS[module.id as keyof typeof MODULE_HINT_KEYS]);
  }

  // На компьютере подпись идёт за названием через «·» со строчной буквы («Чаты · всегда включён»)
  function formatInline(text: string) {
    return `· ${lowerFirst(text, lang.code)}`;
  }

  function renderSettingsLink(module: ParvaneModuleState) {
    const id = module.id as keyof typeof SETTINGS_LINK_KEYS;
    if (!module.isOn || !SETTINGS_LINK_KEYS[id]) return undefined;
    if (isDesk) {
      return (
        <button
          type="button"
          className={buildClassName(kit.chip, styles.rowChip)}
          data-module-settings={id}
          onClick={handleOpenSettings}
        >
          {lang(SETTINGS_LINK_KEYS[id])}
        </button>
      );
    }
    return (
      <button type="button" className={styles.moduleLink} data-module-settings={id} onClick={handleOpenSettings}>
        <span className={styles.blockTitle}>{lang(SETTINGS_LINK_PHONE_KEYS[id])}</span>
        <span className={styles.moduleLinkArrow} aria-hidden>›</span>
      </button>
    );
  }

  function renderBlocks() {
    if (isDesk) {
      return (
        <div className={styles.blockChips}>
          <span className={styles.blockChipsLabel}>{lang('ParvaneNavBlocks')}</span>
          {HEALTH_BLOCK_IDS.map((block) => {
            const isOn = prefs.healthBlocks.includes(block);
            return (
              <button
                key={block}
                type="button"
                className={buildClassName(kit.chip, isOn && kit.chipOn)}
                aria-pressed={isOn}
                data-block={block}
                onClick={handleBlockChipClick}
              >
                {lang(HEALTH_BLOCK_TITLE_KEYS[block])}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <div className={styles.blocks}>
        {HEALTH_BLOCK_IDS.map((block) => {
          const blockTitle = lang(HEALTH_BLOCK_TITLE_KEYS[block]);
          return (
            <div key={block} className={styles.block}>
              <span className={styles.blockTitle}>{blockTitle}</span>
              <PvSwitch
                isOn={prefs.healthBlocks.includes(block)}
                label={blockTitle}
                data-block={block}
                onChange={handleBlockToggle}
              />
            </div>
          );
        })}
      </div>
    );
  }

  function renderModule(module: ParvaneModuleState) {
    const title = lang(MODULE_TITLE_KEYS[module.id]);
    const isSwitchDisabled = module.isLocked || module.isServerOff || module.isUnavailable;
    const isDragged = drag?.id === module.id;
    const hasExtra = !isDesk && module.isOn
      && (module.id === 'health' || Boolean(SETTINGS_LINK_KEYS[module.id as keyof typeof SETTINGS_LINK_KEYS]));
    const isExpanded = hasExtra && expandedIds.includes(module.id);
    return (
      <div key={module.id} role="listitem" data-module-row={module.id}>
        <div
          className={buildClassName(styles.row, isDesk && styles.rowDesk, isDragged && styles.rowDrop)}
          data-module={module.id}
          data-on={module.isOn}
          data-dragging={isDragged || undefined}
        >
          <button
            type="button"
            className={styles.handle}
            aria-label={lang('ParvaneNavDrag', { name: title })}
            data-drag-handle={module.id}
            onKeyDown={handleHandleKeyDown}
            onPointerDown={handlePointerDown}
          >
            <ParvaneIcon name="grip" isSmall />
          </button>
          <ParvaneIcon
            name={MODULE_ICONS[module.id]}
            className={buildClassName(styles.icon, !module.isOn && styles.iconOff)}
          />
          {isDesk ? (
            <div className={styles.text}>
              <span className={buildClassName(styles.title, !module.isOn && styles.titleOff)}>{title}</span>
              {' '}
              <span className={styles.subtitleInline}>
                {isDragged ? lang('ParvaneNavDropHere') : formatInline(getSubtitle(module))}
              </span>
            </div>
          ) : hasExtra ? (
            <button
              type="button"
              className={buildClassName(styles.text, styles.textButton)}
              aria-expanded={isExpanded}
              data-module-expand={module.id}
              onClick={handleExpandClick}
            >
              <div className={buildClassName(styles.title, !module.isOn && styles.titleOff)}>{title}</div>
              <div className={styles.subtitle}>{isDragged ? lang('ParvaneNavDropHere') : getSubtitle(module)}</div>
              <ParvaneIcon
                name={isExpanded ? 'chevronUp' : 'chevronDown'}
                isSmall
                className={styles.expandIcon}
              />
            </button>
          ) : (
            <div className={styles.text}>
              <div className={buildClassName(styles.title, !module.isOn && styles.titleOff)}>{title}</div>
              <div className={styles.subtitle}>{isDragged ? lang('ParvaneNavDropHere') : getSubtitle(module)}</div>
            </div>
          )}
          {isDesk && renderSettingsLink(module)}
          <PvSwitch
            isOn={module.isOn}
            label={title}
            isDisabled={isSwitchDisabled}
            className={styles.switch}
            data-module={module.id}
            onChange={handleToggle}
          />
        </div>
        {!isDesk && isExpanded && renderSettingsLink(module)}
        {module.id === 'health' && module.isOn && (isDesk || isExpanded) && renderBlocks()}
      </div>
    );
  }

  // След «было здесь» — на прежнем месте перетаскиваемой строки, пока она стоит в другом
  function renderRows() {
    const rows = modules.map(renderModule);
    if (!drag) return rows;
    const currentIndex = modules.findIndex((module) => module.id === drag.id);
    if (currentIndex < 0 || currentIndex === drag.startIndex) return rows;
    const traceAt = currentIndex < drag.startIndex ? drag.startIndex + 1 : drag.startIndex;
    rows.splice(traceAt, 0, (
      <div key="trace" className={styles.trace} aria-hidden data-module-trace>
        <span>{lang(MODULE_TITLE_KEYS[drag.id])}</span>
        <span className={styles.traceNote}>{lang('ParvaneNavWasHere')}</span>
      </div>
    ));
    return rows;
  }

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.root, isDesk && styles.rootDesk)}>
      {isDesk ? (
        <p className={styles.deskHint}>{lang('ParvaneNavModulesDeskHint')}</p>
      ) : (
        <>
          <div className={styles.hint}>
            <ParvaneIcon name="info" isSmall className={styles.hintIcon} />
            <span>{lang('ParvaneModulesHint', undefined, { withNodes: true, withMarkdown: true })}</span>
          </div>
          <div className={styles.dragHint}>{lang('ParvaneNavDragHint')}</div>
        </>
      )}
      <div ref={listRef} className={buildClassName(styles.list, isDesk && styles.listDesk)} role="list">
        {renderRows()}
      </div>
      <div className={styles.footnote}>
        {lang(isDesk ? 'ParvaneNavModulesDeskFootnote' : 'ParvaneModulesOrderHint')}
      </div>
    </div>
  );
};

function lowerFirst(text: string, locale: string) {
  return `${text.charAt(0).toLocaleLowerCase(locale)}${text.slice(1)}`;
}

export default memo(SettingsModules);
