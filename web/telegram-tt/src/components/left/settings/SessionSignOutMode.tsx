import { memo, useMemo } from '../../../lib/teact/teact';

import useOldLang from '../../../hooks/useOldLang';

import RadioGroup from '../../ui/RadioGroup';

// Parvane: как завершить сеанс — обычный выход (ключи прежние) или выход со сменой ключей, которые устройство
// держало (потеряно или украдено)
export type SignOutMode = 'keep' | 'rotate';

type OwnProps = {
  name: string;
  selected: SignOutMode;
  onChange: (mode: SignOutMode) => void;
};

const SessionSignOutMode = ({ name, selected, onChange }: OwnProps) => {
  const oldLang = useOldLang();

  const options = useMemo(() => [
    { value: 'keep', label: oldLang('ParvaneSignOutKeep'), subLabel: oldLang('ParvaneSignOutKeepHint') },
    { value: 'rotate', label: oldLang('ParvaneSignOutRotate'), subLabel: oldLang('ParvaneSignOutRotateHint') },
  ], [oldLang]);

  return (
    <RadioGroup
      name={name}
      options={options}
      selected={selected}
      onChange={(value) => onChange(value as SignOutMode)}
    />
  );
};

export default memo(SessionSignOutMode);
