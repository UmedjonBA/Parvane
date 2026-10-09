import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatProject, listColorStyle } from './plannerFormat';
import { ensureList, LIST_COLOR_COUNT } from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Select from '../../ui/Select';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type SwatchesProps = {
  value: number;
  onChange: (color: number) => void;
};

type OwnProps = {
  id: string;
  state: PlannerState;
  // Имя списка; пустая строка — «Без списка»
  value: string;
  onChange: (project: string) => void;
};

const NEW_LIST_VALUE = '\u0000new';
const LIST_NAME_MAX_LENGTH = 60;
const COLORS = Array.from({ length: LIST_COLOR_COUNT + 1 }, (_, index) => index);

// Кружки выбора цвета списка: 0 — без цвета
const PlannerColorSwatchesInner = ({ value, onChange }: SwatchesProps) => {
  const lang = useLang();

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onChange(Number(e.currentTarget.dataset.color));
  });

  return (
    <div className={styles.swatches} role="radiogroup" aria-label={lang('PlannerListColor')}>
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          className={buildClassName(styles.swatch, !color && styles.swatchNone, color === value && styles.swatchActive)}
          style={listColorStyle(color)}
          aria-checked={color === value}
          aria-label={color ? lang('PlannerListColorN', { n: color }) : lang('PlannerListColorNone')}
          data-color={color}
          onClick={handleClick}
        />
      ))}
    </div>
  );
};

export const PlannerColorSwatches = memo(PlannerColorSwatchesInner);

// Выбор списка задачи: существующие, «Без списка» и создание нового на месте (с цветом)
const PlannerListPicker = ({
  id, state, value, onChange,
}: OwnProps) => {
  const lang = useLang();

  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(0);
  const [error, setError] = useState<string>();

  const handleSelect = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    if (e.currentTarget.value === NEW_LIST_VALUE) {
      setIsCreating(true);
      return;
    }
    onChange(e.currentTarget.value);
  });

  const handleCancel = useLastCallback(() => {
    setIsCreating(false);
    setName('');
    setError(undefined);
  });

  const handleCreate = useLastCallback(() => {
    const listName = name.trim();
    if (!listName) {
      setError(lang('PlannerErrorListName'));
      return;
    }
    if (!state.projects.includes(listName)) {
      updatePlanner((draft) => {
        const list = ensureList(draft, listName);
        if (list && color) list.color = color;
      }, lang('PlannerNoticeListCreated', { name: listName }));
    }
    onChange(listName);
    handleCancel();
  });

  if (isCreating) {
    return (
      <div className={styles.listCreate} data-list-create>
        <PlannerField
          label={lang('PlannerNewList')}
          type="text"
          value={name}
          maxLength={LIST_NAME_MAX_LENGTH}
          onInput={setName}
        />
        <PlannerColorSwatches value={color} onChange={setColor} />
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <Button size="smaller" onClick={handleCreate}>{lang('PlannerCreateList')}</Button>
          <Button isText size="smaller" onClick={handleCancel}>{lang('Cancel')}</Button>
        </div>
      </div>
    );
  }

  // Только что созданный список попадает в состояние на следующей отрисовке — его пункт нужен сразу,
  // иначе выбор остаётся на прежнем значении
  const projects = state.projects.includes(value) ? state.projects : [...state.projects, value];

  return (
    <Select
      id={id}
      label={lang('PlannerFieldList')}
      value={value}
      hasArrow
      onChange={handleSelect}
    >
      {projects.map((item) => <option key={item} value={item}>{formatProject(lang, item)}</option>)}
      <option value={NEW_LIST_VALUE}>{lang('PlannerCreateListOption')}</option>
    </Select>
  );
};

export default memo(PlannerListPicker);
