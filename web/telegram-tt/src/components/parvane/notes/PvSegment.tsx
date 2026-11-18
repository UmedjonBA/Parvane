import { memo } from '../../../lib/teact/teact';

import type { PvIconName } from './PvIcon';

import buildClassName from '../../../util/buildClassName';

import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './PvSegment.module.scss';

export type PvSegmentItem<T extends string> = { value: T; label: string; icon?: PvIconName };

type OwnProps<T extends string> = {
  items: PvSegmentItem<T>[];
  value: T;
  label: string;
  className?: string;
  // Переключатель видов экрана — вкладки; иначе группа кнопок с признаком «нажата»
  isTabs?: boolean;
  onChange: (value: T) => void;
};

// Переключатель макета (`.seg` в `pv.css`): сегменты одной ширины в рамке, выбранный — на цвете панели
const PvSegment = <T extends string>({
  items, value, label, className, isTabs, onChange,
}: OwnProps<T>) => {
  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onChange(e.currentTarget.dataset.value as T);
  });

  return (
    <div className={buildClassName(styles.root, className)} role={isTabs ? 'tablist' : 'group'} aria-label={label}>
      {items.map((item) => {
        const isOn = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role={isTabs ? 'tab' : undefined}
            aria-selected={isTabs ? isOn : undefined}
            aria-pressed={isTabs ? undefined : isOn}
            className={buildClassName(styles.item, isOn && styles.itemOn)}
            data-value={item.value}
            data-view={isTabs ? item.value : undefined}
            onClick={handleClick}
          >
            {item.icon && <PvIcon name={item.icon} isSmall />}
            {item.label}
          </button>
        );
      })}
    </div>
  );
};

export default memo(PvSegment);
