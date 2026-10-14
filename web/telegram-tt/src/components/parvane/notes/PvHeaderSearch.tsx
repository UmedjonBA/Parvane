import { memo, useEffect, useRef } from '../../../lib/teact/teact';

import { requestMeasure } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import { SEARCH_FIELD_PROPS } from '../../../util/searchField';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import SearchForm from '../../ui/SearchForm';
import PvIcon from './PvIcon';

import kit from './PvKit.module.scss';

type OwnProps = {
  value: string;
  // Подпись поля: что ищем на этой вкладке
  label: string;
  id?: string;
  // Телефон: поле раскрыто вместо вкладок шапки. На компьютере поле в шапке видно всегда
  isOpen: boolean;
  onOpen: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
  onChange: (value: string) => void;
  onEnter?: NoneToVoidFunction;
};

// Поиск по текущей вкладке раздела — в шапке. На телефоне лупа раскрывает поле на месте вкладок
const PvHeaderSearch = ({
  value, label, id, isOpen, onOpen, onClose, onChange, onEnter,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();

  const lang = useLang();

  useEffect(() => {
    if (!isOpen) return;
    requestMeasure(() => inputRef.current?.focus());
  }, [isOpen]);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.currentTarget.value);
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onEnter?.();
      return;
    }
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (value) onChange('');
    else onClose();
  });

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          className={buildClassName(kit.ib, kit.onlyM)}
          aria-label={label}
          data-section-search-open
          onClick={onOpen}
        >
          <PvIcon name="search" />
        </button>
      )}
      <SearchForm>
        <label className={buildClassName(kit.search, kit.hdrSearch, !isOpen && kit.hideM)}>
          <PvIcon name="search" isSmall className={kit.searchIcon} />
          <input
            ref={inputRef}
            {...SEARCH_FIELD_PROPS}
            id={id}
            className={buildClassName(kit.searchInput, kit.hdrSearchInput)}
            value={value}
            placeholder={label}
            aria-label={label}
            enterKeyHint="search"
            data-section-search
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
        </label>
      </SearchForm>
      {isOpen && (
        <button
          type="button"
          className={buildClassName(kit.ib, kit.onlyM)}
          aria-label={lang('Close')}
          data-section-search-close
          onClick={onClose}
        >
          <PvIcon name="x" />
        </button>
      )}
    </>
  );
};

export default memo(PvHeaderSearch);
