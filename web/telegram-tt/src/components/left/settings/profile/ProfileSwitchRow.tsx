import buildClassName from '../../../../util/buildClassName';

import PvSwitch from '../../../parvane/notes/PvSwitch';

import styles from './Profile.module.scss';

type OwnProps = {
  title: string;
  hint?: string;
  isOn: boolean;
  isDisabled?: boolean;
  onChange: (isOn: boolean) => void;
};

// Строка экрана «Профиля» с выключателем (доски `PhProfileA/B`, `DkSettingsB`): название, подпись под ним, дорожка
// справа; нажатие по всей строке; доступное имя — название. Атрибуты `data-*` переходят на кнопку
// (`role="switch"`) — по ним её находят сценарии
const ProfileSwitchRow = ({
  title, hint, isOn, isDisabled, onChange, ...marks
}: OwnProps) => {
  return (
    <PvSwitch
      isOn={isOn}
      label={title}
      isDisabled={isDisabled}
      className={buildClassName(styles.setRow, styles.setRowAction)}
      onChange={onChange}
      {...marks}
    >
      <span className={styles.setText}>
        <span className={styles.setTitle}>{title}</span>
        {hint && <span className={styles.setHint}>{hint}</span>}
      </span>
    </PvSwitch>
  );
};

export default ProfileSwitchRow;
