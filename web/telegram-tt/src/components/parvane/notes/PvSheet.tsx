import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import Modal from '../../ui/Modal';
import PvIcon from './PvIcon';

import kit from './PvKit.module.scss';

type OwnProps = {
  isOpen: boolean;
  title?: string;
  className?: string;
  // Кнопки шапки перед названием и после него (перед крестиком)
  headBefore?: TeactNode;
  headAfter?: TeactNode;
  isWide?: boolean;
  // Список строк: строки стоят вплотную
  isTight?: boolean;
  children: React.ReactNode;
  onClose: NoneToVoidFunction;
  onEnter?: NoneToVoidFunction;
};

// Шторка прототипа: окно сверху по центру на компьютере, лист снизу с ручкой на телефоне.
// Название слева, крестик справа
const PvSheet = ({
  isOpen, title, className, headBefore, headAfter, isWide, isTight, children, onClose, onEnter,
}: OwnProps) => {
  const lang = useLang();

  const header = (
    <>
      <div className={kit.sheetGrab} />
      <div className={kit.sheetHead}>
        {headBefore}
        <h2 className={kit.sheetTitle} dir="auto">{title}</h2>
        {headAfter}
        <button type="button" className={kit.ib} aria-label={lang('Close')} onClick={onClose}>
          <PvIcon name="x" />
        </button>
      </div>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      className={buildClassName(kit.sheet, isWide && kit.sheetWide, isTight && kit.sheetTight, className)}
      header={header}
      onClose={onClose}
      onEnter={onEnter}
    >
      {children}
    </Modal>
  );
};

export default memo(PvSheet);
