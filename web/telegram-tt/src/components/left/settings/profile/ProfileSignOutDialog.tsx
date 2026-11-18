import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { callApi } from '../../../../api/gramjs';

import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import ConfirmDialog from '../../../ui/ConfirmDialog';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

// Parvane: выход — последний пункт «Профиля». Выход с единственного устройства стирает ключи — диалог
// предупреждает про ключ восстановления
const ProfileSignOutDialog = ({ isOpen, onClose }: OwnProps) => {
  const { signOut } = getActions();
  const oldLang = useOldLang();
  // Пока ответ не пришёл (или запрос упал), показываем строгое предупреждение, а не обычное
  const [isLastDevice, setIsLastDevice] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    setIsLastDevice(true);
    void (callApi as unknown as (name: string) => Promise<boolean | undefined>)('parvaneIsLastDevice')
      .then((isLast) => setIsLastDevice(isLast !== false))
      .catch(() => undefined);
  }, [isOpen]);

  const handleConfirm = useLastCallback(() => {
    onClose();
    signOut({ forceInitApi: true });
  });

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      text={oldLang(isLastDevice ? 'ParvaneLogoutLastDevice' : 'lng_sure_logout')}
      confirmLabel={oldLang('AccountSettings.Logout')}
      confirmHandler={handleConfirm}
      confirmIsDestructive
    />
  );
};

export default memo(ProfileSignOutDialog);
