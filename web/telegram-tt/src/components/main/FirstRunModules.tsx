import { memo } from '../../lib/teact/teact';

import type { ParvaneModuleId, ParvaneModuleState } from '../../util/parvaneModules';

import buildClassName from '../../util/buildClassName';
import { describeFirstRunCount, getIsFirstRunDone, markFirstRunDone } from '../../util/parvaneFirstRun';
import { setModuleOn } from '../../util/parvaneModules';
import { MODULE_ICONS, MODULE_TITLE_KEYS } from './parvaneModuleNav';

import useAppLayout from '../../hooks/useAppLayout';
import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useParvaneModules from '../../hooks/useParvaneModules';

import PvSwitch from '../parvane/notes/PvSwitch';
import Portal from '../ui/Portal';
import ParvaneIcon from './ParvaneIcon';

import kit from '../parvane/notes/PvKit.module.scss';
import styles from './ParvaneShell.module.scss';

// Порядок карточки — как на досках, а не порядок ленты пользователя
const MODULE_ORDER: ParvaneModuleId[] = ['chats', 'plan', 'health', 'notes', 'files', 'music', 'profile'];
const HINT_KEYS = {
  plan: { phone: 'ShellFirstRunHintPlan', desktop: 'ShellFirstRunHintPlanDesktop' },
  health: { phone: 'ShellFirstRunHintHealth', desktop: 'ShellFirstRunHintHealthDesktop' },
  notes: { phone: 'ShellFirstRunHintNotes', desktop: 'ShellFirstRunHintNotesDesktop' },
  files: { phone: 'ShellFirstRunHintFiles', desktop: 'ShellFirstRunHintFilesDesktop' },
  music: { phone: 'ShellFirstRunHintMusic', desktop: 'ShellFirstRunHintMusic' },
  chats: { phone: 'ShellFirstRunChatsOn', desktop: 'ShellFirstRunChatsOn' },
  profile: { phone: 'ShellFirstRunProfileOn', desktop: 'ShellFirstRunProfileOn' },
} as const satisfies Record<ParvaneModuleId, { phone: string; desktop: string }>;

// Parvane (доски `XpStart`, `ZdNav`): первый запуск — «Что вам нужно в Parvane?». Один раз на устройство после
// входа: выключатели пишут набор модулей сразу (лента и панель меняются на глазах), «Начать» / «Продолжить»
// закрывает экран. Модули, выключенные сервером, не показываются. Телефон — страница с «Чатами» и «Профилем»
// (всегда включены), компьютер — окно с пятью модулями
const FirstRunModules = () => {
  const lang = useLang();
  const { isMobile } = useAppLayout();
  const isDone = useDerivedState(getIsFirstRunDone);
  const { states } = useParvaneModules();

  const handleToggle = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    setModuleOn(e.currentTarget.dataset.firstRunModule as ParvaneModuleId, isOn);
  });

  const shown = MODULE_ORDER
    .map((id) => states.find((module) => module.id === id))
    .filter((module): module is ParvaneModuleState => Boolean(module && !module.isServerOff && !module.isUnavailable))
    .filter((module) => isMobile || !module.isLocked);

  const handleEnableAll = useLastCallback(() => {
    shown.forEach((module) => {
      if (!module.isOn && !module.isLocked) setModuleOn(module.id, true);
    });
  });

  // До первого ответа движка списка модулей ещё нет — экран ждёт его
  if (isDone || !states.length) return undefined;

  const count = describeFirstRunCount(shown.filter((module) => module.isOn).length, shown.length);
  const cardRows = shown.map((module) => (
    <div key={module.id} className={styles.row} data-first-run-row={module.id}>
      <ParvaneIcon name={MODULE_ICONS[module.id]} className={styles.rowIcon} />
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{lang(MODULE_TITLE_KEYS[module.id])}</span>
        <span className={styles.rowSub}>{lang(HINT_KEYS[module.id][isMobile ? 'phone' : 'desktop'])}</span>
      </span>
      <PvSwitch
        isOn={module.isOn}
        isDisabled={module.isLocked}
        label={lang(MODULE_TITLE_KEYS[module.id])}
        data-first-run-module={module.id}
        onChange={handleToggle}
      />
    </div>
  ));

  if (isMobile) {
    return (
      <Portal>
        <div className={buildClassName(styles.overlay, styles.pageOverlay)} data-first-run="phone">
          <div className={styles.page} role="dialog" aria-label={lang('ShellFirstRunTitle')}>
            <div>
              <h1 className={buildClassName(styles.title, styles.titleLarge)}>{lang('ShellFirstRunTitle')}</h1>
              <p className={styles.text}>{lang('ShellFirstRunText')}</p>
            </div>
            <div className={styles.card}>{cardRows}</div>
            <span className={styles.spacer} />
            <p className={styles.counter} data-first-run-count={count.selected}>
              {lang(count.doesFit ? 'ShellFirstRunCountFits' : 'ShellFirstRunCountScrolls', {
                selected: count.selected, total: count.total,
              })}
            </p>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
              data-first-run-done
              onClick={markFirstRunDone}
            >
              {lang('ShellFirstRunStart')}
            </button>
            <button type="button" className={styles.textButton} data-first-run-all onClick={handleEnableAll}>
              {lang('ShellFirstRunAll')}
            </button>
          </div>
        </div>
      </Portal>
    );
  }

  return (
    <Portal>
      <div className={styles.overlay} data-first-run="desktop">
        <div className={styles.dialog} role="dialog" aria-label={lang('ShellFirstRunTitleDesktop')}>
          <span className={styles.logo} aria-hidden>P</span>
          <div>
            <h1 className={styles.title}>{lang('ShellFirstRunTitleDesktop')}</h1>
            <p className={styles.text}>{lang('ShellFirstRunTextDesktop')}</p>
          </div>
          <div className={styles.card}>{cardRows}</div>
          <p className={styles.foot}>{lang('ShellFirstRunFootDesktop')}</p>
          <div className={styles.buttons}>
            <button type="button" className={kit.btn} data-first-run-all onClick={handleEnableAll}>
              {lang('ShellFirstRunAll')}
            </button>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              data-first-run-done
              onClick={markFirstRunDone}
            >
              {lang('ShellFirstRunContinue')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default memo(FirstRunModules);
