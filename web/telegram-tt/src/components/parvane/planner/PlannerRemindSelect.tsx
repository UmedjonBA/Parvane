import { memo } from '../../../lib/teact/teact';

import { formatRemindShort } from './plannerEditorFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Select from '../../ui/Select';

type OwnProps = {
  id: string;
  // Подпись поля; нет — «Напомнить»
  label?: string;
  // Минут до начала; нет значения — без напоминания
  value?: number;
  // Простой выбор без плавающей подписи — значение в строке настроек (доска `RdPlanSet`)
  plainClassName?: string;
  onChange: (value: number | undefined) => void;
};

// Варианты «за сколько напомнить», минут; своё значение из ввода текстом добавляется в список
const REMIND_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 24 * 60, 7 * 24 * 60];
// Непустое: пустой `value` пункта при перерисовке снимается, и поле показывало пустоту вместо «Без напоминания»
const NONE_VALUE = 'none';

// Поле «Напомнить» карточки задачи и события (этап 4 плана 15 окт 2026): значение без повтора подписи — «За 15 мин»
// (доска `PhPlanMore`)
const PlannerRemindSelect = ({
  id, label, value, plainClassName, onChange,
}: OwnProps) => {
  const lang = useLang();

  const options = value === undefined || REMIND_OPTIONS.includes(value)
    ? REMIND_OPTIONS : [...REMIND_OPTIONS, value].sort((a, b) => a - b);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const raw = e.currentTarget.value;
    onChange(raw === NONE_VALUE ? undefined : Number(raw));
  });

  const selected = value === undefined ? NONE_VALUE : String(value);
  const items = (
    <>
      <option value={NONE_VALUE}>{lang('PlannerRemindNone')}</option>
      {options.map((minutes) => (
        <option key={minutes} value={String(minutes)}>{formatRemindShort(lang, minutes)}</option>
      ))}
    </>
  );

  if (plainClassName) {
    return (
      <select
        id={id}
        className={plainClassName}
        value={selected}
        aria-label={label || lang('PlannerRemind')}
        onChange={handleChange}
      >
        {items}
      </select>
    );
  }

  return (
    <Select id={id} label={label || lang('PlannerRemind')} value={selected} hasArrow onChange={handleChange}>
      {items}
    </Select>
  );
};

export default memo(PlannerRemindSelect);
