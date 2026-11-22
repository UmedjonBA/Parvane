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
  // Строка под названием (о чём шторка: название заметки, папка)
  subtitle?: string;
  className?: string;
  // Кнопки шапки перед названием и после него (перед крестиком)
  headBefore?: TeactNode;
  headAfter?: TeactNode;
  isWide?: boolean;
  // Экран телефона (доски `PhFilesMore`, `XpFiles`, `ZpFilesX`): закрытие слева — стрелкой «‹» (`back`) либо
  // крестиком «Отмена» (`cancel`), без крестика справа
  startClose?: 'back' | 'cancel';
  // Телефон: шторка — страница во весь экран (доски `PhFilesMore-02`, `ZpFilesX-01`): полоса шапки на панели,
  // содержимое на фоне, без ручки
  isPage?: boolean;
  // Окно без крестика: закрывают кнопки внизу (доска `XdChat`)
  noClose?: boolean;
  // Список строк: строки стоят вплотную
  isTight?: boolean;
  children: React.ReactNode;
  onClose: NoneToVoidFunction;
  onEnter?: NoneToVoidFunction;
};

// Шторка прототипа: окно сверху по центру на компьютере, лист снизу с ручкой на телефоне.
// Название слева, крестик справа
const PvSheet = ({
  isOpen, title, subtitle, className, headBefore, headAfter, isWide, startClose, isPage, noClose, isTight, children,
  onClose, onEnter,
}: OwnProps) => {
  const lang = useLang();

  const header = (
    <>
      <div className={kit.sheetGrab} />
      <div className={kit.sheetHead}>
        {startClose && (
          <button
            type="button"
            className={kit.ib}
            aria-label={lang(startClose === 'back' ? 'Back' : 'Cancel')}
            data-sheet-close={startClose}
            onClick={onClose}
          >
            <PvIcon name={startClose === 'back' ? 'left' : 'x'} />
          </button>
        )}
        {headBefore}
        {subtitle ? (
          <div className={kit.sheetTitles}>
            <h2 className={kit.sheetTitle} dir="auto">{title}</h2>
            <p className={kit.sheetSubtitle} dir="auto" data-sheet-subtitle>{subtitle}</p>
          </div>
        ) : <h2 className={kit.sheetTitle} dir="auto">{title}</h2>}
        {headAfter}
        {!startClose && !noClose && (
          <button type="button" className={kit.ib} aria-label={lang('Close')} onClick={onClose}>
            <PvIcon name="x" />
          </button>
        )}
      </div>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      className={buildClassName(
        kit.sheet, isWide && kit.sheetWide, isTight && kit.sheetTight, isPage && kit.sheetPage, className,
      )}
      header={header}
      onClose={onClose}
      onEnter={onEnter}
    >
      {children}
    </Modal>
  );
};

export default memo(PvSheet);
