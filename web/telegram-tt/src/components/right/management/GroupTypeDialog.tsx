import { memo } from '../../../lib/teact/teact';

import useLang from '../../../hooks/useLang';

import PvSheet from '../../parvane/notes/PvSheet';
import ManageChatPrivacyType from './ManageChatPrivacyType';

type OwnProps = {
  chatId: string;
  isChannel?: boolean;
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

// Parvane (доска `XdChat`): на компьютере «Тип группы» — окно поверх чата с «Отмена / Сохранить» внизу; на
// телефоне — экран правой колонки
const GroupTypeDialog = ({
  chatId, isChannel, isOpen, onClose,
}: OwnProps) => {
  const lang = useLang();

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang(isChannel ? 'ParvaneChannelType' : 'ParvaneGroupType')}
      className="pv-type-dialog"
      noClose
      onClose={onClose}
    >
      <ManageChatPrivacyType chatId={chatId} isActive={isOpen} isDialog onClose={onClose} />
    </PvSheet>
  );
};

export default memo(GroupTypeDialog);
