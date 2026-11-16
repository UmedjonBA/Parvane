import { memo, useState } from '@teact';

import type { HealthBlockId, ParvaneModuleId, ParvaneModuleState } from '../../../util/parvaneModules';

import buildClassName from '../../../util/buildClassName';
import {
  HEALTH_BLOCK_IDS, moveModule, setHealthBlockOn, setModuleOn,
} from '../../../util/parvaneModules';
import { MODULE_ICONS, MODULE_TITLE_KEYS } from '../../main/parvaneModuleNav';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import ParvaneIcon from '../../main/ParvaneIcon';

import styles from './SettingsModules.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

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

// Parvane: «Профиль → Модули» — какие модули показывать и в каком порядке. Настройка этого устройства.
// Порядок меняется перетаскиванием строки за ручку и кнопками «выше / ниже» (клавиатура, сенсор)
const SettingsModules = ({ isActive, onReset }: OwnProps) => {
  const lang = useLang();
  const { states: modules, prefs } = useParvaneModules();
  const [draggedId, setDraggedId] = useState<ParvaneModuleId>();
  const [overId, setOverId] = useState<ParvaneModuleId>();

  useHistoryBack({ isActive, onBack: onReset });

  const handleToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.module as ParvaneModuleId;
    setModuleOn(id, e.currentTarget.getAttribute('aria-checked') !== 'true');
  });

  const handleBlockToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const block = e.currentTarget.dataset.block as HealthBlockId;
    setHealthBlockOn(block, e.currentTarget.getAttribute('aria-checked') !== 'true');
  });

  const handleMove = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.module as ParvaneModuleId;
    const index = modules.findIndex((module) => module.id === id);
    moveModule(id, index + Number(e.currentTarget.dataset.step));
  });

  const handleDragStart = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.module as ParvaneModuleId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDraggedId(id);
  });

  const handleDragOver = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedId) return;
    e.preventDefault();
    setOverId(e.currentTarget.dataset.module as ParvaneModuleId);
  });

  const handleDragEnd = useLastCallback(() => {
    setDraggedId(undefined);
    setOverId(undefined);
  });

  const handleDrop = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const targetId = e.currentTarget.dataset.module as ParvaneModuleId;
    if (draggedId && draggedId !== targetId) {
      moveModule(draggedId, modules.findIndex((module) => module.id === targetId));
    }
    handleDragEnd();
  });

  function getSubtitle(module: ParvaneModuleState) {
    if (module.isLocked) return lang('ParvaneModuleAlwaysOn');
    if (module.isServerOff) return lang('ParvaneModuleServerOff');
    if (module.isUnavailable) return lang('ParvaneModuleSoon');
    if (!module.isOn) return lang('ParvaneModuleHidden');
    if (module.id === 'health') {
      return lang('ParvaneModuleHealthBlocks', { count: prefs.healthBlocks.length, total: HEALTH_BLOCK_IDS.length });
    }
    return lang(MODULE_HINT_KEYS[module.id as keyof typeof MODULE_HINT_KEYS]);
  }

  function renderSwitch(
    isOn: boolean, label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, isDisabled: boolean,
    data: { module?: ParvaneModuleId; block?: HealthBlockId },
  ) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-label={label}
        disabled={isDisabled}
        data-module={data.module}
        data-block={data.block}
        className={buildClassName(styles.switch, isOn && styles.switchOn, isDisabled && styles.switchLocked)}
        onClick={onClick}
      />
    );
  }

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.root)}>
      <div className={styles.hint}>
        <ParvaneIcon name="warn" isSmall className={styles.hintIcon} />
        <span>{lang('ParvaneModulesHint', undefined, { withNodes: true, withMarkdown: true })}</span>
      </div>
      <div className={styles.list} role="list">
        {modules.map((module, index) => {
          const title = lang(MODULE_TITLE_KEYS[module.id]);
          const isSwitchDisabled = module.isLocked || module.isServerOff || module.isUnavailable;
          return (
            <div key={module.id} role="listitem">
              <div
                className={buildClassName(
                  styles.row, draggedId === module.id && styles.rowDragged, overId === module.id && styles.rowOver,
                )}
                draggable
                data-module={module.id}
                data-on={module.isOn}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              >
                <span className={styles.handle} aria-hidden>⋮⋮</span>
                <ParvaneIcon
                  name={MODULE_ICONS[module.id]}
                  className={buildClassName(styles.icon, !module.isOn && styles.iconOff)}
                />
                <div className={styles.text}>
                  <div className={buildClassName(styles.title, !module.isOn && styles.titleOff)}>{title}</div>
                  <div className={styles.subtitle}>{getSubtitle(module)}</div>
                </div>
                <button
                  type="button"
                  className={styles.move}
                  aria-label={lang('ParvaneModuleMoveUp', { name: title })}
                  data-module={module.id}
                  data-step={-1}
                  disabled={index === 0}
                  onClick={handleMove}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.move}
                  aria-label={lang('ParvaneModuleMoveDown', { name: title })}
                  data-module={module.id}
                  data-step={1}
                  disabled={index === modules.length - 1}
                  onClick={handleMove}
                >
                  ↓
                </button>
                {renderSwitch(module.isOn, title, handleToggle, isSwitchDisabled, { module: module.id })}
              </div>
              {module.id === 'health' && module.isOn && (
                <div className={styles.blocks}>
                  {HEALTH_BLOCK_IDS.map((block) => {
                    const blockTitle = lang(HEALTH_BLOCK_TITLE_KEYS[block]);
                    return (
                      <div key={block} className={styles.block}>
                        <span className={styles.blockTitle}>{blockTitle}</span>
                        {renderSwitch(
                          prefs.healthBlocks.includes(block), blockTitle, handleBlockToggle, false, { block },
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.footnote}>{lang('ParvaneModulesOrderHint')}</div>
    </div>
  );
};

export default memo(SettingsModules);
