import type { FC } from '../../../lib/teact/teact';
import {
  memo,
  useCallback, useEffect, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import { ChatCreationProgress } from '../../../types';

import { getUserFirstOrLastName, getUserFullName } from '../../../global/helpers';
import { selectTabState } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import PrivateChatInfo from '../../common/PrivateChatInfo';
import PvSwitch from '../../parvane/notes/PvSwitch';
import AvatarEditable from '../../ui/AvatarEditable';
import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import Spinner from '../../ui/Spinner';

export // Публичное имя группы (spec 023): как ник — 5–32, латиница, цифры, `_`, с буквы
const PUBLIC_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

type OwnProps = {
  isChannel?: boolean;
  isActive: boolean;
  memberIds: string[];
  onReset: (forceReturnToChatList?: boolean) => void;
};

type StateProps = {
  creationProgress?: ChatCreationProgress;
  creationError?: string;
  maxGroupSize?: number;
};

const MAX_MEMBERS_FOR_GENERATE_CHAT_NAME = 4;

const NewChatStep2: FC<OwnProps & StateProps> = ({
  isChannel,
  isActive,
  memberIds,
  maxGroupSize,
  creationProgress,
  creationError,
  onReset,
}) => {
  const {
    createGroupChat,
    createChannel,
    resetChatCreation,
  } = getActions();

  const lang = useOldLang();
  const newLang = useLang();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const [title, setTitle] = useState('');
  // Parvane: название, введённое пользователем, не затирается сгенерированным
  // «A & B» — эффект ниже срабатывает и при смене `lang` (пакет языка
  // подгружается асинхронно), и группа создавалась с чужим названием
  const isTitleTouchedRef = useRef(false);
  // Название, с которым ушло создание, и текущее: позднее подтверждение прежней группы не должно снимать отметку
  // «название ввели руками» у следующей — иначе автоназвание по участникам затирало введённое
  const submittedTitleRef = useRef<string>();
  const titleRef = useRef(title);
  titleRef.current = title;
  const [about, setAbout] = useState('');
  // Parvane: как вступают в новую группу или канал — по ссылке сразу либо по заявке
  const [isJoinRequestNeeded, setIsJoinRequestNeeded] = useState(false);
  // Parvane (spec 023): публичное имя — группа сразу публичная (пусто — частная); «Закрытая / Публичная» по
  // доске `ZpChat2` — поле имени видно только у публичной
  const [isPublic, setIsPublic] = useState(false);
  // Канал (доска `ZpChat2`): «Кто пишет» — только создатель либо он и отмеченные участники
  const [isWritersSelected, setIsWritersSelected] = useState(false);
  const [writerIds, setWriterIds] = useState<string[]>([]);
  const [publicName, setPublicName] = useState('');
  const [photo, setPhoto] = useState<File | undefined>();
  const [error, setError] = useState<string | undefined>();

  const chatTitleEmptyError = 'Chat title can\'t be empty';
  const channelTitleEmptyError = 'Channel title can\'t be empty';
  const chatTooManyUsersError = 'Sorry, creating supergroups is not yet supported';

  const isLoading = creationProgress === ChatCreationProgress.InProgress;

  useEffect(() => {
    if (isChannel) {
      return;
    }
    if (isTitleTouchedRef.current) {
      return;
    }
    if (!memberIds.length || memberIds.length > MAX_MEMBERS_FOR_GENERATE_CHAT_NAME) {
      setTitle('');
      return;
    }
    const global = getGlobal();
    const usersById = global.users.byId;
    const memberFirstNames = [global.currentUserId!, ...memberIds]
      .map((userId) => getUserFirstOrLastName(usersById[userId]))
      .filter(Boolean);
    const generatedChatName = memberFirstNames.slice(0, -1).join(', ')
      + lang('CreateGroup.PeersTitleLastDelimeter')
      + memberFirstNames[memberFirstNames.length - 1];
    setTitle(generatedChatName);
  }, [isChannel, memberIds, lang]);

  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.currentTarget;
    const newValue = value.replace(/^\s+/, '');

    isTitleTouchedRef.current = true;
    setTitle(newValue);

    if (newValue !== value) {
      e.currentTarget.value = newValue;
    }
  }, []);

  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setAbout(e.currentTarget.value);
  }, []);

  const handlePublicNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPublicName(e.currentTarget.value.trim().replace(/^@/, ''));
  }, []);

  const handleSelectPrivate = useLastCallback(() => {
    setIsPublic(false);
  });

  const handleSelectPublic = useLastCallback(() => {
    setIsPublic(true);
  });

  const handleCreateGroup = useCallback(() => {
    if (!title.length) {
      setError(chatTitleEmptyError);
      return;
    }

    if (maxGroupSize && memberIds.length >= maxGroupSize) {
      setError(chatTooManyUsersError);
      return;
    }

    submittedTitleRef.current = title;
    createGroupChat({
      title,
      photo,
      memberIds,
      isJoinRequestNeeded,
      publicName: isPublic && publicName ? publicName : undefined,
    });
  }, [title, memberIds, maxGroupSize, createGroupChat, photo, isJoinRequestNeeded, isPublic, publicName]);

  const handleCreateChannel = useCallback(() => {
    if (!title.length) {
      setError(channelTitleEmptyError);
      return;
    }

    submittedTitleRef.current = title;
    createChannel({
      title,
      about,
      photo,
      memberIds,
      isChannel: true,
      isJoinRequestNeeded,
      publicName: isPublic && publicName ? publicName : undefined,
      writerIds: isWritersSelected ? writerIds.filter((id) => memberIds.includes(id)) : undefined,
    });
  }, [title, createChannel, about, photo, memberIds, channelTitleEmptyError, isJoinRequestNeeded, isPublic,
    publicName, isWritersSelected, writerIds]);

  const handleWritersMe = useCallback(() => setIsWritersSelected(false), []);
  const handleWritersSelected = useCallback(() => setIsWritersSelected(true), []);
  const handleWriterToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { value, checked } = e.currentTarget;
    setWriterIds((current) => (checked ? [...current.filter((id) => id !== value), value]
      : current.filter((id) => id !== value)));
  }, []);

  // Parvane: отметка «создано» снимается здесь же, а колонка сбрасывается, только пока мастер на экране:
  // иначе подтверждение, пришедшее позже, закрывало только что открытый «Профиль»
  useEffect(() => {
    if (creationProgress === ChatCreationProgress.Complete) {
      if (titleRef.current === submittedTitleRef.current) isTitleTouchedRef.current = false;
      resetChatCreation();
      // Сервер подтверждает создание позже, чем открывается чат: человек мог уже уйти с мастера
      if (isActive) onReset(true);
    }
  }, [creationProgress, isActive, onReset]);

  const renderedError = (creationError && lang(creationError)) || (
    error !== chatTitleEmptyError && error !== channelTitleEmptyError
      ? error
      : undefined
  );

  const canCreate = title.length !== 0 && !isLoading;
  const typeLabel = newLang(isChannel ? 'ParvaneChannelTypePublic' : 'ParvaneGroupTypePublic');

  return (
    <div className="NewChat">
      {/* Parvane: шапка по доске `ZpChat2` — шаг 2 из 2 и «Создать» текстом */}
      <div className="left-header pv-new-chat-header">
        <Button
          round
          size="smaller"
          color="translucent"
          onClick={() => onReset()}
          ariaLabel="Return to member selection"
          iconName="previous"
        />
        <div className="pv-new-chat-title">
          <h3 className="pv-new-chat-heading">{lang(isChannel ? 'NewChannel' : 'NewGroup')}</h3>
          <span className="pv-new-chat-step">
            {newLang(isChannel ? 'ParvaneNewChannelStep2' : 'ParvaneNewGroupStep2')}
          </span>
        </div>
        <button
          type="button"
          className="pv-new-chat-action"
          aria-label={isChannel ? lang('ChannelIntro.CreateChannel') : 'Create Group'}
          disabled={!canCreate}
          onClick={isChannel ? handleCreateChannel : handleCreateGroup}
        >
          {isLoading ? <Spinner color="gray" /> : newLang('ParvaneNewChatCreate')}
        </button>
      </div>
      <div className="NewChat-inner step-2 custom-scroll">
        <AvatarEditable
          onChange={setPhoto}
          title={lang('AddPhoto')}
        />
        <div className="pv-new-chat-fields">
          <InputText
            value={title}
            onChange={handleTitleChange}
            label={lang(isChannel ? 'EnterChannelName' : 'GroupName')}
            error={error === chatTitleEmptyError || error === channelTitleEmptyError ? error : undefined}
          />
          {isChannel && (
            <InputText
              value={about}
              onChange={handleDescriptionChange}
              label={lang('DescriptionOptionalPlaceholder')}
            />
          )}
        </div>

        <div className="pv-new-chat-cap">{newLang('ParvaneNewChatType')}</div>
        {isChannel ? (
          <div className="pv-new-chat-grp">
            <PvSwitch className="pv-new-chat-row" isOn={isPublic} onChange={setIsPublic} data-new-chat-public>
              <span className="pv-new-chat-row-text">
                <span>{typeLabel}</span>
                <span className="pv-new-chat-row-sub">{newLang('ParvaneNewChannelPublicInfo')}</span>
              </span>
            </PvSwitch>
          </div>
        ) : (
          <div className="pv-new-chat-seg" role="radiogroup" aria-label={newLang('ParvaneNewChatType')}>
            <button
              type="button"
              role="radio"
              aria-checked={!isPublic}
              className={buildClassName('pv-new-chat-seg-item', !isPublic && 'pv-new-chat-seg-item-on')}
              onClick={handleSelectPrivate}
            >
              {newLang('ParvaneGroupTypeClosed')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isPublic}
              className={buildClassName('pv-new-chat-seg-item', isPublic && 'pv-new-chat-seg-item-on')}
              onClick={handleSelectPublic}
            >
              {typeLabel}
            </button>
          </div>
        )}
        {isPublic && (
          <div className="pv-new-chat-fields">
            <InputText
              id="new-chat-public-name"
              value={publicName}
              onChange={handlePublicNameChange}
              label={newLang(isChannel ? 'ParvaneChannelServerName' : 'ParvaneGroupServerName')}
              error={publicName && !PUBLIC_NAME_REGEX.test(publicName) ? lang('ParvanePublicNameInvalid') : undefined}
            />
          </div>
        )}
        {/* Канал — пояснение доски `ZpChat2`; у публичного остаётся честное предупреждение (PUBLIC-1) */}
        {isChannel && !isPublic ? (
          <p className="note">{newLang('ParvaneNewChannelInfo')}</p>
        ) : (
          <p className="note">{lang(isPublic ? 'ParvanePublicGroupWarning' : 'ParvanePublicNameInfo')}</p>
        )}

        {isChannel && (
          <>
            <div className="pv-new-chat-cap">{newLang('ParvaneChannelWhoWrites')}</div>
            <div className="pv-new-chat-grp" data-new-chat-writers={isWritersSelected ? 'selected' : 'me'}>
              <Checkbox
                label={newLang('ParvaneChannelWritesMe')}
                checked={!isWritersSelected}
                onCheck={handleWritersMe}
              />
              <Checkbox
                label={newLang('ParvaneChannelWritesSelected')}
                checked={isWritersSelected}
                onCheck={handleWritersSelected}
              />
              {isWritersSelected && memberIds.map((id) => (
                <Checkbox
                  key={id}
                  value={id}
                  label={getUserFullName(getGlobal().users.byId[id]) || id}
                  checked={writerIds.includes(id)}
                  onChange={handleWriterToggle}
                />
              ))}
            </div>
            {isWritersSelected && !memberIds.length && (
              <p className="note">{newLang('ParvaneChannelWritesEmpty')}</p>
            )}
          </>
        )}

        <div className="pv-new-chat-grp">
          <PvSwitch
            className="pv-new-chat-row"
            isOn={isJoinRequestNeeded}
            data-new-chat-join-request
            onChange={setIsJoinRequestNeeded}
          >
            <span className="pv-new-chat-row-text">
              {lang('ParvaneJoinByRequest')}
              <span className="pv-new-chat-row-sub">{lang('ParvaneJoinByRequestInfo')}</span>
            </span>
          </PvSwitch>
        </div>

        {renderedError && (
          <p className="error">{renderedError}</p>
        )}

        {memberIds.length > 0 && (
          <>
            <div className="pv-new-chat-cap">{lang('GroupInfo.ParticipantCount', memberIds.length, 'i')}</div>

            <div className="chat-members-list pv-new-chat-grp">
              {memberIds.map((id) => (
                <ListItem inactive className="chat-item-clickable">
                  <PrivateChatInfo userId={id} />
                </ListItem>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const {
      progress: creationProgress,
      error: creationError,
    } = selectTabState(global).chatCreation || {};

    return {
      creationProgress,
      creationError,
      maxGroupSize: global.config?.maxGroupSize,
    };
  },
)(NewChatStep2));
