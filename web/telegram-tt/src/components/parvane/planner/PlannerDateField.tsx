import { useRef } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatCardDay } from './plannerEditorFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';
import more from './PlannerEditor.module.scss';

type OwnProps = {
  label: string;
  // День `YYYY-MM-DD`; пусто — `empty`
  value?: string;
  // Подпись пустого значения: «Без срока», «Без даты»
  empty: string;
  className?: string;
  // Сразу после выбора (пусто — дата снята)
  onChange: (value: string) => void;
};

// Дата в строке карточки записи (доски `DkPlanMore`, `PhPlanMore`): значение словами — «вс, 15 ноября»; выбор —
// родное поле даты поверх подписи (прозрачное, открывает выбор по нажатию)
const PlannerDateField = ({
  label, value, empty, className, onChange,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.currentTarget.value);
  });

  // Выбор даты — сразу календарём, а не правкой частей поля
  const handleClick = useLastCallback(() => {
    try {
      inputRef.current?.showPicker();
    } catch (err) {
      // Браузер без `showPicker` открывает выбор сам либо даёт править поле
    }
  });

  return (
    <label className={buildClassName(styles.field, more.dateField, className)}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={buildClassName('form-control', styles.fieldInput, more.dateValue, !value && more.dateEmpty)}>
        {value ? formatCardDay(lang, value) : empty}
        <input
          ref={inputRef}
          type="date"
          className={more.dateNative}
          value={value || ''}
          aria-label={label}
          onChange={handleChange}
          onClick={handleClick}
        />
      </span>
    </label>
  );
};

export default PlannerDateField;
