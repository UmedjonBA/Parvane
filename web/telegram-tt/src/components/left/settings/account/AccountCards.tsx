import { memo } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import { SettingsScreens } from '../../../../types';

import { selectUser } from '../../../../global/selectors';
import buildClassName from '../../../../util/buildClassName';
import { readAccountEmail } from '../../../../util/parvaneAccountEmail';
import { getProfileServer } from '../profile/profileFormat';
import { openProfileWindow } from '../profile/profileRequests';

import useAppLayout from '../../../../hooks/useAppLayout';
import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ChangePasswordDialog from '../profile/ChangePasswordDialog';
import ProfileSignOutDialog from '../profile/ProfileSignOutDialog';

import kit from '../../../parvane/notes/PvKit.module.scss';
import profile from '../profile/Profile.module.scss';
import styles from './Account.module.scss';

type OwnProps = {
  // Смена ключа подписи устройств возможна только корнем: он на устройстве либо есть его копия (`sskState`)
  canRotateSsk?: boolean;
  onRotateSsk: NoneToVoidFunction;
};

type StateProps = {
  nick?: string;
};

// Parvane (spec 041, доска `DkSettingsA`): «Устройства и аккаунт» — карточка аккаунта (ник, пароль, ключ подписи
// устройств) и «Опасная зона» (выйти на этом устройстве, удалить аккаунт). Строки ведут на прежние действия: ник
// меняется в «Изменить профиль», пароль — окном «Сменить пароль» поверх экрана (`ZdProfileX`), ключ подписи — окном
// ключа восстановления. Почта (её помнит устройство, где аккаунт создавали) и сервер — с доски `PhProfileB`.
// Строки «Ключ восстановления · показать» нет: ключ на устройстве не хранится
const AccountCards = ({
  canRotateSsk, nick, onRotateSsk,
}: OwnProps & StateProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const [isSignOutOpen, openSignOut, closeSignOut] = useFlag();
  const [isPasswordOpen, openPassword, closePassword] = useFlag();
  const { isDesktop } = useAppLayout();
  const email = readAccountEmail(nick);
  const server = getProfileServer();

  // Компьютер — окна поверх «Профиля» (доска `RdProfile`), телефон — экраны
  const handleNick = useLastCallback(() => {
    if (isDesktop) {
      openProfileWindow('edit');
      return;
    }
    openSettingsScreen({ screen: SettingsScreens.EditProfile });
  });

  const handleDelete = useLastCallback(() => {
    if (isDesktop) {
      openProfileWindow('delete');
      return;
    }
    openSettingsScreen({ screen: SettingsScreens.ParvaneDeleteAccount });
  });

  const rowClass = buildClassName(profile.setRow, profile.setRowAction);

  return (
    <div className={styles.cards}>
      <div className={buildClassName(profile.group, styles.card)} data-account-card>
        <button type="button" className={rowClass} data-account-row="nick" onClick={handleNick}>
          <span className={profile.setTitle}>{lang('ParvaneAccountNick')}</span>
          {nick && <span className={profile.setValue}>{`@${nick}`}</span>}
        </button>
        {email && (
          <div className={profile.setRow} data-account-row="email">
            <span className={profile.setTitle}>{lang('ParvaneAccountEmail')}</span>
            <span className={profile.setValue}>{email}</span>
          </div>
        )}
        {server && (
          <div className={profile.setRow} data-account-row="server">
            <span className={profile.setTitle}>{lang('ParvaneAboutServer')}</span>
            <span className={profile.setValue}>{server}</span>
          </div>
        )}
        <button type="button" className={rowClass} data-account-row="password" onClick={openPassword}>
          <span className={profile.setTitle}>{lang('ParvaneAccountPassword')}</span>
          <span className={buildClassName(profile.setValue, profile.setValueWord)}>{lang('ParvaneAccountChange')}</span>
        </button>
        {canRotateSsk && (
          <button type="button" className={rowClass} data-account-row="ssk" onClick={onRotateSsk}>
            <span className={profile.setTitle}>{lang('ParvaneAccountSigningKey')}</span>
            <span className={buildClassName(profile.setValue, profile.setValueWord)}>
              {lang('ParvaneAccountChange')}
            </span>
          </button>
        )}
        <p className={styles.cardHint}>{lang('ParvaneAccountNickHint')}</p>
      </div>
      <div className={buildClassName(profile.group, styles.card, styles.danger)} data-danger-zone>
        <div className={styles.dangerCaption}>{lang('ParvaneAccountDangerZone')}</div>
        <button type="button" className={buildClassName(kit.btn, kit.btnWide)} onClick={openSignOut}>
          {lang(isDesktop ? 'ParvaneAccountSignOutComputer' : 'ParvaneAccountSignOutHere')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnWide, kit.btnDanger)}
          data-delete-account-open
          onClick={handleDelete}
        >
          {lang('ParvaneDeleteAccountTitle')}
        </button>
        <p className={styles.dangerHint}>{lang('ParvaneAccountDeleteHint')}</p>
      </div>
      <ProfileSignOutDialog isOpen={isSignOutOpen} onClose={closeSignOut} />
      <ChangePasswordDialog isOpen={isPasswordOpen} onClose={closePassword} />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const user = global.currentUserId ? selectUser(global, global.currentUserId) : undefined;
    return { nick: user?.usernames?.[0]?.username };
  },
)(AccountCards));
