import { memo } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';

import PvSheet from '../../../parvane/notes/PvSheet';
import ProfileIcon from './ProfileIcon';

import styles from './Profile.module.scss';

export type ProfileChoice = { value: string; label: string };

type OwnProps = {
  isOpen: boolean;
  title: string;
  hint?: string;
  options: ProfileChoice[];
  selected: string;
  onSelect: (value: string) => void;
  onClose: NoneToVoidFunction;
};

// Выбор одного значения строки «Профиля» (доска `PhProfileB`: «Писать мне — Только контакты»): шторка со списком,
// выбранное помечено галочкой; выбор закрывает шторку
const ProfileChoiceSheet = ({
  isOpen, title, hint, options, selected, onSelect, onClose,
}: OwnProps) => {
  return (
    <PvSheet isOpen={isOpen} title={title} isTight onClose={onClose}>
      <div className={styles.choiceList} role="radiogroup" aria-label={title}>
        {options.map((option) => {
          const isSelected = option.value === selected;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={buildClassName(styles.setRow, styles.setRowAction, styles.choiceRow)}
              data-choice={option.value}
              onClick={() => {
                onSelect(option.value);
                onClose();
              }}
            >
              <span className={styles.setTitle}>{option.label}</span>
              {isSelected && <ProfileIcon name="check" isSmall className={styles.toneAccent} />}
            </button>
          );
        })}
      </div>
      {hint && <div className={styles.choiceHint}>{hint}</div>}
    </PvSheet>
  );
};

export default memo(ProfileChoiceSheet);
