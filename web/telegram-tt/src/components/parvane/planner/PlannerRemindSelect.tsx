import { memo } from '../../../lib/teact/teact';

import { formatRemind } from './plannerFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Select from '../../ui/Select';

type OwnProps = {
  id: string;
  // Минут до начала; нет значения — без напоминания
  value?: number;
  onChange: (value: number | undefined) => void;
};

// Варианты «за сколько напомнить», минут; своё значение из ввода текстом добавляется в список
const REMIND_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 24 * 60, 7 * 24 * 60];
// Непустое: пустой `value` пункта при перерисовке снимается, и поле показывало пустоту вместо «Без напоминания»
const NONE_VALUE = 'none';

// Поле «Напомнить» карточки задачи и события (этап 4 плана 15 окт 2026)
const PlannerRemindSelect = ({ id, value, onChange }: OwnProps) => {
  const lang = useLang();

  const options = value === undefined || REMIND_OPTIONS.includes(value)
    ? REMIND_OPTIONS : [...REMIND_OPTIONS, value].sort((a, b) => a - b);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const raw = e.currentTarget.value;
    onChange(raw === NONE_VALUE ? undefined : Number(raw));
  });

  return (
    <Select
      id={id}
      label={lang('PlannerRemind')}
      value={value === undefined ? NONE_VALUE : String(value)}
      hasArrow
      onChange={handleChange}
    >
      <option value={NONE_VALUE}>{lang('PlannerRemindNone')}</option>
      {options.map((minutes) => (
        <option key={minutes} value={String(minutes)}>{formatRemind(lang, minutes)}</option>
      ))}
    </Select>
  );
};

export default memo(PlannerRemindSelect);
