import { memo, useEffect, useRef } from '../../../lib/teact/teact';

import { requestMeasure } from '../../../lib/fasterdom/fasterdom';
import { SEARCH_FIELD_PROPS } from '../../../util/searchField';

import useLastCallback from '../../../hooks/useLastCallback';

import SearchForm from '../../ui/SearchForm';
import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type OwnProps = {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onClose: NoneToVoidFunction;
};

// Поле экрана поиска на телефоне (доска `ZpFilesX`): под шапкой «‹ Файлы / поиск», с подписью «Поиск по файлам»
const CloudSearchField = ({
  value, label, onChange, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();

  useEffect(() => {
    requestMeasure(() => inputRef.current?.focus());
  }, []);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.currentTarget.value);
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (value) onChange('');
    else onClose();
  });

  return (
    <SearchForm>
      <label className={styles.searchField}>
        <span className={styles.searchLabel}>{label}</span>
        <span className={kit.search}>
          <PvIcon name="search" isSmall className={kit.searchIcon} />
          <input
            ref={inputRef}
            {...SEARCH_FIELD_PROPS}
            className={kit.searchInput}
            value={value}
            placeholder={label}
            aria-label={label}
            enterKeyHint="search"
            data-section-search
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
        </span>
      </label>
    </SearchForm>
  );
};

export default memo(CloudSearchField);
