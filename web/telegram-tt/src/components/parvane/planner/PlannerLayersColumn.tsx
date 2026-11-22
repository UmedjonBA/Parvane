import { memo } from '../../../lib/teact/teact';

import type { PlannerLayer } from './plannerLayers';
import type { PlannerState } from './plannerModel';
import type { PlannerSearchShow } from './plannerTools';

import buildClassName from '../../../util/buildClassName';
import { listColorStyle } from './plannerFormat';
import {
  getIsLayerLocked, getPlannerLayerPrefs, PLANNER_LAYERS, toggleGroupLayer, toggleLayer, toggleSearchShow,
} from './plannerLayers';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import PvIcon from '../notes/PvIcon';

import planner from './Planner.module.scss';
import styles from './PlannerLayersColumn.module.scss';

type OwnProps = {
  state: PlannerState;
  // `search` — «Что показывать» поиска, `day` — слои календаря вида «День»
  variant: 'search' | 'day';
};

const SHOW_ITEMS: { value: PlannerSearchShow; key: 'PlannerSearchEvents' | 'PlannerSearchTasks'
  | 'PlannerSearchShowDone' | 'PlannerSearchShowOffers'; }[] = [
  { value: 'events', key: 'PlannerSearchEvents' },
  { value: 'tasks', key: 'PlannerSearchTasks' },
  { value: 'done', key: 'PlannerSearchShowDone' },
  { value: 'offers', key: 'PlannerSearchShowOffers' },
];
const LAYER_KEYS = {
  events: 'PlannerSearchEvents',
  tasks: 'PlannerSearchTasks',
  sleep: 'PlannerHealthSleep',
  food: 'PlannerHealthFood',
  sport: 'PlannerLayerSport',
} as const satisfies Record<PlannerLayer, string>;
const LAYER_KINDS = {
  events: planner.kindEvent,
  tasks: planner.kindTask,
  sleep: planner.kindSleep,
  food: planner.kindFood,
  sport: planner.kindWorkout,
} satisfies Record<PlannerLayer, string>;

// Колонка «Слои / Что показывать» на компьютере (доска `ZdPlanX`): слои — группы «Плана» с их цветом и «Без
// группы» (выключенная прячется и в календаре, и в поиске); ниже — что показывать в поиске либо слои календаря
// вида «День» (слой «Здоровья» заблокирован, когда модуль или его блок выключен). Настройка устройства
const PlannerLayersColumn = ({ state, variant }: OwnProps) => {
  const lang = useLang();
  const prefs = useDerivedState(getPlannerLayerPrefs);
  const { enabled, prefs: modulePrefs } = useParvaneModules();
  const isHealthOn = enabled.includes('health');

  const handleGroup = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    toggleGroupLayer(e.currentTarget.dataset.layerGroup!);
  });

  const handleShow = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    toggleSearchShow(e.currentTarget.dataset.show as PlannerSearchShow);
  });

  const handleLayer = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    toggleLayer(e.currentTarget.dataset.layer as PlannerLayer);
  });

  const groups = [
    ...state.lists.map((list) => ({ name: list.name, label: list.name, color: list.color || 0 })),
    { name: '', label: lang('PlannerNoList'), color: 0 },
  ];

  return (
    <aside className={styles.root} data-planner-layers={variant}>
      <h3 className={styles.title}>{lang('PlannerLayersGroups')}</h3>
      <div className={styles.list} role="group" aria-label={lang('PlannerLayersGroups')}>
        {groups.map((group) => (
          <LayerRow
            key={group.name || '\u0000'}
            isOn={!prefs.groupsOff.includes(group.name)}
            data-layer-group={group.name}
            onChange={handleGroup}
          >
            <span className={styles.dot} style={listColorStyle(group.color)} />
            <span className={styles.label}>{group.label}</span>
          </LayerRow>
        ))}
      </div>
      <h3 className={styles.title}>{lang('PlannerSearchShow')}</h3>
      <div className={styles.list} role="group" aria-label={lang('PlannerSearchShow')}>
        {variant === 'search' ? SHOW_ITEMS.map((item) => (
          <LayerRow
            key={item.value}
            isOn={prefs.searchShow.includes(item.value)}
            data-show={item.value}
            onChange={handleShow}
          >
            <span className={styles.label}>{lang(item.key)}</span>
          </LayerRow>
        )) : PLANNER_LAYERS.map((layer) => {
          const isLocked = getIsLayerLocked(layer, isHealthOn, modulePrefs.healthBlocks);
          return (
            <LayerRow
              key={layer}
              isOn={!isLocked && prefs.layers[layer]}
              isDisabled={isLocked}
              className={LAYER_KINDS[layer]}
              data-layer={layer}
              onChange={handleLayer}
            >
              <span className={buildClassName(styles.dot, styles.dotKind)} />
              <span className={styles.label}>
                {lang(LAYER_KEYS[layer])}
                {isLocked && <span className={styles.hint}>{lang('PlannerLayerBlockOff')}</span>}
              </span>
            </LayerRow>
          );
        })}
      </div>
    </aside>
  );
};

type RowProps = {
  isOn: boolean;
  isDisabled?: boolean;
  className?: string;
  children: React.ReactNode;
  onChange: (isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => void;
};

// Строка слоя (доска `ZdPlanX`): включённый — галочкой у правого края, выключенный — приглушён. Для сценариев и
// чтения с экрана это выключатель (`role="switch"`), как прежде; атрибуты `data-*` вызова переносятся на кнопку
function LayerRow({
  isOn, isDisabled, className, children, onChange, ...marks
}: RowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      disabled={isDisabled}
      className={buildClassName(styles.item, !isOn && styles.itemOff, className)}
      {...marks}
      onClick={(e) => onChange(!isOn, e)}
    >
      {children}
      {isOn && <PvIcon name="check" isSmall className={styles.check} />}
    </button>
  );
}

export default memo(PlannerLayersColumn);
