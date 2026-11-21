import { memo, useEffect } from '../../lib/teact/teact';
import { getActions } from '../../global';

import { SettingsScreens } from '../../types';

import { consumeExportAfterLogin } from '../../util/parvaneExportAfterLogin';
import { openUpgradeDialog } from '../../util/parvaneUpgrade';
import { callApi } from '../../api/gramjs';
import { openModule } from './parvaneModuleNav';
import useGlobalHotkeys from './useGlobalHotkeys';

import useFlag from '../../hooks/useFlag';

import FirstRunModules from './FirstRunModules';
import HotkeysDialog from './HotkeysDialog';
import UpgradeRequired from './UpgradeRequired';

const UPGRADE_REQUIRED_EVENT = 'parvane-upgrade-required';

// Parvane: экраны оболочки по доске `ZdNav` — первый запуск (выбор модулей), «Нужно обновить приложение» и
// горячие клавиши (Ctrl+/ и сочетания «Везде»). Смонтирован в `Main` всегда
const ParvaneShellHost = () => {
  const [isHotkeysOpen, openHotkeys, closeHotkeys] = useFlag();

  useGlobalHotkeys(openHotkeys);

  // Сервер не принимает эту версию протокола: событие провайдера могло прийти до монтирования — спросить
  useEffect(() => {
    void (callApi as unknown as (name: string) => Promise<boolean | undefined>)('parvaneIsUpgradeRequired')
      .then((isRequired) => {
        if (isRequired) openUpgradeDialog();
      });
    window.addEventListener(UPGRADE_REQUIRED_EVENT, openUpgradeDialog);
    return () => window.removeEventListener(UPGRADE_REQUIRED_EVENT, openUpgradeDialog);
  }, []);

  // Вход с экрана «Аккаунт будет удалён» ради выгрузки (доска `RpProfileC`) — сразу «Выгрузить мои данные»
  useEffect(() => {
    if (!consumeExportAfterLogin()) return;
    openModule('profile', false);
    getActions().openSettingsScreen({ screen: SettingsScreens.ParvaneExport });
  }, []);

  return (
    <>
      <FirstRunModules />
      <UpgradeRequired />
      <HotkeysDialog isOpen={isHotkeysOpen} onClose={closeHotkeys} />
    </>
  );
};

export default memo(ParvaneShellHost);
