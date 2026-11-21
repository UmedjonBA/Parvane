import { memo, useLayoutEffect, useState } from '../../../../lib/teact/teact';

import type { KeysFileTab } from './profileRequests';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import Modal from '../../../ui/Modal';
import KeysFileForm from './KeysFileForm';

type OwnProps = {
  user?: string;
  // Вкладка, с которой окно открывается; `undefined` — окно закрыто
  openTab?: KeysFileTab;
  onClose: NoneToVoidFunction;
  onDone: NoneToVoidFunction;
};

// Окно файла копии ключей поверх «Данных и памяти» и «Копии ключей» на компьютере (доска `DkSettingsB`: «Сохранить
// новую / Восстановить» в карточке «Копия сохранена …»); содержимое — та же форма, что на экране телефона
const KeysFileDialog = ({
  user, openTab, onClose, onDone,
}: OwnProps) => {
  const lang = useLang();
  const [tab, setTab] = useState<KeysFileTab>('save');

  useLayoutEffect(() => {
    if (openTab) setTab(openTab);
  }, [openTab]);

  const handleDone = useLastCallback(() => {
    onDone();
    onClose();
  });

  return (
    <Modal isOpen={Boolean(openTab)} title={lang('ParvaneKeysFileTitle')} hasCloseButton onClose={onClose}>
      <KeysFileForm user={user} tab={tab} onTabChange={setTab} onDone={handleDone} />
    </Modal>
  );
};

export default memo(KeysFileDialog);
