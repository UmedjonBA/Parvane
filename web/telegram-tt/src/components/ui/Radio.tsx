import type { ChangeEvent, MouseEventHandler } from 'react';
import type { FC, TeactNode } from '../../lib/teact/teact';
import { memo } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';

import Spinner from './Spinner';

import './Radio.scss';

type OwnProps = {
  id?: string;
  name?: string;
  label?: TeactNode;
  subLabel?: TeactNode;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  isCanCheckedInDisabled?: boolean;
  isLink?: boolean;
  hidden?: boolean;
  isLoading?: boolean;
  withIcon?: boolean;
  className?: string;
  onlyInput?: boolean;
  subLabelClassName?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  onSubLabelClick?: MouseEventHandler<HTMLSpanElement> | undefined;
};

const Radio: FC<OwnProps> = ({
  id,
  label,
  subLabel,
  subLabelClassName,
  value,
  name,
  checked,
  disabled,
  hidden,
  isLoading,
  className,
  onlyInput,
  withIcon,
  isLink,
  onChange,
  onSubLabelClick,
  isCanCheckedInDisabled,
}) => {
  const fullClassName = buildClassName(
    'Radio',
    className,
    disabled && 'disabled',
    hidden && 'hidden-widget',
    withIcon && 'with-icon',
    isLoading && 'loading',
    onlyInput && 'onlyInput',
    Boolean(subLabel) && 'withSubLabel',
    isCanCheckedInDisabled && 'canCheckedInDisabled',
  );

  return (
    <label className={fullClassName}>
      <input
        type="radio"
        name={name}
        value={value}
        id={id}
        checked={checked}
        onChange={onChange}
        disabled={disabled || hidden}
      />
      <div className="Radio-main">
        <span className="label">{label}</span>
        {Boolean(subLabel) && (
          <span
            className={buildClassName(subLabelClassName, 'subLabel', isLink ? 'subLabelLink' : undefined)}
            onClick={isLink ? onSubLabelClick : undefined}
          >
            {subLabel}
          </span>
        )}
      </div>
      {isLoading && <Spinner />}
    </label>
  );
};

export default memo(Radio);
