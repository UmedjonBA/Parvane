import { memo } from '../../../lib/teact/teact';
import { withGlobal } from '../../../global';

import type { ApiChatMember, ApiUser, ApiUserStatus } from '../../../api/types';

import { getUserFullName, getUserStatus } from '../../../global/helpers';
import { selectUser, selectUserStatus } from '../../../global/selectors';

import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import Avatar from '../../common/Avatar';

import styles from './GroupInfo.module.scss';

type OwnProps = {
  userId: string;
  member?: ApiChatMember;
};

type StateProps = {
  user?: ApiUser;
  userStatus?: ApiUserStatus;
};

const AVATAR_SIZE = 36;

// Parvane (доска `ZpChat2`): строка участника в сведениях группы — аватар 36 px, имя («Вы» у себя), под ним роль
// и статус: «админ · в сети»
const GroupMember = ({ member, user, userStatus }: OwnProps & StateProps) => {
  const lang = useLang();
  const oldLang = useOldLang();
  if (!user) return undefined;

  const role = member?.rank
    || (member?.isOwner ? lang('ParvaneMemberOwner') : undefined)
    || (member?.isAdmin ? lang('ParvaneMemberAdmin') : undefined)
    || (member?.isWriter ? lang('ParvaneChannelAuthor') : undefined);
  // У себя статус «в сети» очевиден: при роли показывается только она
  const status = user.isSelf && role ? undefined : getUserStatus(oldLang, user, userStatus);
  const subtitle = [role, status].filter(Boolean).join(' · ');

  return (
    <div className={styles.member}>
      <Avatar peer={user} size={AVATAR_SIZE} />
      <div className={styles.memberText}>
        <span className={styles.memberName} dir="auto">
          {user.isSelf ? lang('ParvaneMemberYou') : getUserFullName(user)}
        </span>
        {subtitle && <span className={styles.memberSub} data-member-sub>{subtitle}</span>}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { userId }): Complete<StateProps> => ({
    user: selectUser(global, userId),
    userStatus: selectUserStatus(global, userId),
  }),
)(GroupMember));
