import type { FC } from '../../../lib/teact/teact';
import { memo, useCallback } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiUser } from '../../../api/types';

import { getMainUsername, getUserFullName } from '../../../global/helpers';
import { selectUser } from '../../../global/selectors';
import { createClassNameBuilder } from '../../../util/buildClassName';
import { formatHumanDate, formatTime, isToday } from '../../../util/dates/oldDateFormat';
import { getServerTime } from '../../../util/serverTime';

import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import Avatar from '../../common/Avatar';
import Button from '../../ui/Button';

import './JoinRequest.scss';

const AVATAR_SIZE = 36;

type OwnProps = {
  userId: string;
  about?: string;
  date: number;
  chatId: string;
};

type StateProps = {
  user?: ApiUser;
};

const JoinRequest: FC<OwnProps & StateProps> = ({
  userId,
  chatId,
  about,
  date,
  user,
}) => {
  const { openChat, hideChatJoinRequest } = getActions();

  const buildClassName = createClassNameBuilder('JoinRequest');
  const lang = useOldLang();
  const newLang = useLang();

  const fullName = getUserFullName(user);
  // eslint-disable-next-line @eslint-react/purity
  const fixedDate = (date - getServerTime()) * 1000 + Date.now();

  const dateString = isToday(new Date(fixedDate))
    ? formatTime(lang, fixedDate) : formatHumanDate(lang, fixedDate, true, false, true);

  const username = user && getMainUsername(user);
  const subtitle = [username && `@${username}`, dateString].filter(Boolean).join(' · ');

  const handleUserClick = () => {
    openChat({ id: userId });
  };

  const handleAcceptRequest = useCallback(() => {
    hideChatJoinRequest({ chatId, userId, isApproved: true });
  }, [chatId, hideChatJoinRequest, userId]);

  const handleRejectRequest = useCallback(() => {
    hideChatJoinRequest({ chatId, userId, isApproved: false });
  }, [chatId, hideChatJoinRequest, userId]);

  return (
    <div className={buildClassName('&')}>
      <div className={buildClassName('top')}>
        <div className={buildClassName('user')} onClick={handleUserClick}>
          <Avatar
            key={userId}
            size={AVATAR_SIZE}
            peer={user}
          />
          <div className={buildClassName('user-info')}>
            <div className={buildClassName('user-name')}>{fullName}</div>
            <div className={buildClassName('user-subtitle')}>{subtitle}</div>
            {about && <div className={buildClassName('user-subtitle')}>{about}</div>}
          </div>
        </div>
      </div>
      <div className={buildClassName('buttons')}>
        <Button className={buildClassName('button')} onClick={handleAcceptRequest}>
          {newLang('ParvaneJoinRequestAccept')}
        </Button>
        <Button className={buildClassName('button')} onClick={handleRejectRequest}>
          {newLang('ParvaneJoinRequestDecline')}
        </Button>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { userId }): Complete<StateProps> => {
    const user = selectUser(global, userId);

    return {
      user,
    };
  },
)(JoinRequest));
