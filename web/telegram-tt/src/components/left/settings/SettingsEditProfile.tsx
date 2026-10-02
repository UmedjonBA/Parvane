import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiBirthday, ApiUsername } from '../../../api/types';
import { ApiMediaFormat } from '../../../api/types';
import { ProfileEditProgress } from '../../../types';

import { getChatAvatarHash } from '../../../global/helpers';
import { selectTabState, selectUser, selectUserFullInfo } from '../../../global/selectors';
import { selectCurrentLimit } from '../../../global/selectors/limits';
import buildClassName from '../../../util/buildClassName';
import { formatDateToString } from '../../../util/dates/oldDateFormat';
import { throttle } from '../../../util/schedulers';
import { callApi } from '../../../api/gramjs';
import { buildParvaneUserLink } from '../../common/helpers/formatUsername';
import renderText from '../../common/helpers/renderText';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMedia from '../../../hooks/useMedia';
import useOldLang from '../../../hooks/useOldLang';
import usePreviousDeprecated from '../../../hooks/usePreviousDeprecated';

import ManageUsernames from '../../common/ManageUsernames';
import ChatOrUserPicker from '../../common/pickers/ChatOrUserPicker';
import Island, { IslandDescription, IslandOutside, IslandTitle } from '../../gili/layout/Island';
import Surface from '../../gili/layout/Surface';
import AvatarEditable from '../../ui/AvatarEditable';
import FloatingActionButton from '../../ui/FloatingActionButton';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import TextArea from '../../ui/TextArea';

type OwnProps = {
  isActive: boolean;
  onReset: () => void;
};

type StateProps = {
  currentAvatarHash?: string;
  currentFirstName?: string;
  currentLastName?: string;
  currentBirthday?: ApiBirthday;
  currentBio?: string;
  progress?: ProfileEditProgress;
  checkedUsername?: string;
  editUsernameError?: string;
  isUsernameAvailable?: boolean;
  maxBioLength: number;
  usernames?: ApiUsername[];
  currentNameColor?: number;
  currentPhone?: string;
  currentPersonalChannelId?: string;
  currentPersonalChannelTitle?: string;
  channelIds: string[];
};

// Parvane: цвет имени, личный канал и телефон хранятся в identity, а нативных
// редакторов этих полей в Web A нет — минимальные строки из штатных примитивов
// (spec 002 US7, plan Complexity Tracking). Премиум-гейтов нет
const PEER_COLOR_COUNT = 7;
// Индекс 0 не предлагаем: сервер держит name_color числом и трактует 0 как
// «не задан» (identity: `if color != 0`), поэтому выбор первого цвета молча
// не сохранялся бы. Цвета 1..7 различимы и одинаково читаются десктопом;
// менять провод ради нуля нельзя (FR-001)
const FIRST_SELECTABLE_COLOR = 1;
type ParvaneProfileFields = { nameColor?: number; personalChannelId?: string; phone?: string };
const updateParvaneProfile = (fields: ParvaneProfileFields) => (
  (callApi as unknown as (name: string, args: ParvaneProfileFields) => Promise<unknown>)(
    'parvaneUpdateProfileFields', fields,
  )
);

const runThrottled = throttle((cb) => cb(), 60000, true);

const ERROR_FIRST_NAME_MISSING = 'Please provide your first name';

const SettingsEditProfile = ({
  isActive,
  currentAvatarHash,
  currentFirstName,
  currentLastName,
  currentBirthday,
  currentBio,
  progress,
  checkedUsername,
  editUsernameError,
  isUsernameAvailable,
  maxBioLength,
  usernames,
  currentNameColor,
  currentPhone,
  currentPersonalChannelId,
  currentPersonalChannelTitle,
  channelIds,
  onReset,
}: OwnProps & StateProps) => {
  const {
    loadCurrentUser,
    updateProfile,
    openBirthdaySetupModal,
  } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();

  const firstEditableUsername = useMemo(() => usernames?.find(({ isEditable }) => isEditable), [usernames]);
  const currentUsername = firstEditableUsername?.username || '';
  const [isUsernameTouched, setIsUsernameTouched] = useState(false);
  const [isProfileFieldsTouched, setIsProfileFieldsTouched] = useState(false);
  // Синхронная отметка «пользователь уже печатает»: ответ `loadCurrentUser`
  // приходит асинхронно и мог затереть введённое в том же кадре (в поле текст
  // оставался, а в состоянии — пусто, и сохранялось пустое значение)
  const areProfileFieldsDirtyRef = useRef(false);
  const [error, setError] = useState<string | undefined>();

  const [photo, setPhoto] = useState<File | undefined>();
  const [firstName, setFirstName] = useState(currentFirstName || '');
  const [lastName, setLastName] = useState(currentLastName || '');
  const [bio, setBio] = useState(currentBio || '');
  const [editableUsername, setEditableUsername] = useState<string | false>(currentUsername);
  const [phone, setPhone] = useState(currentPhone || '');
  const [isPhoneTouched, setIsPhoneTouched] = useState(false);
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isChannelPickerOpen, setIsChannelPickerOpen] = useState(false);
  const [channelSearch, setChannelSearch] = useState('');
  const readOnlyUsername = usernames?.[0]?.username;

  const currentAvatarBlobUrl = useMedia(currentAvatarHash, false, ApiMediaFormat.BlobUrl);

  const isLoading = progress === ProfileEditProgress.InProgress;
  const isUsernameError = editableUsername === false;

  const previousIsUsernameAvailable = usePreviousDeprecated(isUsernameAvailable);
  const renderingIsUsernameAvailable = isUsernameAvailable ?? previousIsUsernameAvailable;
  const shouldRenderUsernamesManage = usernames && usernames.length > 1;

  const isSaveButtonShown = useMemo(() => {
    if (isUsernameError) {
      return false;
    }

    return Boolean(photo) || isProfileFieldsTouched || isPhoneTouched
      || (isUsernameTouched && renderingIsUsernameAvailable === true);
  }, [isUsernameError, photo, isProfileFieldsTouched, isPhoneTouched, isUsernameTouched, renderingIsUsernameAvailable]);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  // Due to the parent Transition, this component never gets unmounted,
  // that's why we use throttled API call on every update.
  useEffect(() => {
    runThrottled(() => {
      loadCurrentUser();
    });
  }, [loadCurrentUser]);

  useEffect(() => {
    setPhoto(undefined);
  }, [currentAvatarBlobUrl]);

  useEffect(() => {
    if (areProfileFieldsDirtyRef.current) return;
    setFirstName(currentFirstName || '');
    setLastName(currentLastName || '');
    setBio(currentBio || '');
  }, [currentFirstName, currentLastName, currentBio]);

  useEffect(() => {
    setEditableUsername(currentUsername || '');
  }, [currentUsername]);

  useEffect(() => {
    setPhone(currentPhone || '');
    setIsPhoneTouched(false);
  }, [currentPhone]);

  useEffect(() => {
    if (progress === ProfileEditProgress.Complete) {
      areProfileFieldsDirtyRef.current = false;
      setIsProfileFieldsTouched(false);
      setIsUsernameTouched(false);
      setError(undefined);
    }
  }, [progress]);

  const formattedBirthday = useMemo(() => {
    if (!currentBirthday) return undefined;

    const date = new Date(
      currentBirthday.year || 2024, // Use leap year as fallback
      currentBirthday.month - 1,
      currentBirthday.day,
    );

    return formatDateToString(date, lang.code, true, 'long');
  }, [currentBirthday, lang]);

  const handlePhotoChange = useLastCallback((newPhoto: File) => {
    setPhoto(newPhoto);
  });

  const handleFirstNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFirstName(e.target.value);
    areProfileFieldsDirtyRef.current = true;
    setIsProfileFieldsTouched(true);
  });

  const handleLastNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLastName(e.target.value);
    areProfileFieldsDirtyRef.current = true;
    setIsProfileFieldsTouched(true);
  });

  const handleBioChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBio(e.target.value);
    areProfileFieldsDirtyRef.current = true;
    setIsProfileFieldsTouched(true);
  });

  const handlePhoneChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPhone(e.target.value);
    setIsPhoneTouched(e.target.value.trim() !== (currentPhone || ''));
  });

  const handleNameColorSelect = useLastCallback((color: number) => {
    setIsColorPickerOpen(false);
    void updateParvaneProfile({ nameColor: color });
  });

  const handlePersonalChannelSelect = useLastCallback((chatId: string) => {
    setIsChannelPickerOpen(false);
    void updateParvaneProfile({ personalChannelId: chatId });
  });

  const handlePersonalChannelRemove = useLastCallback(() => {
    void updateParvaneProfile({ personalChannelId: '' });
  });

  const handleBirthdayClick = useLastCallback(() => {
    openBirthdaySetupModal({ currentBirthday });
  });

  const handleProfileSave = useLastCallback(() => {
    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();
    const trimmedBio = bio.trim();

    // Parvane: у пользователей нет username — пустая строка не должна блокировать
    // сохранение; блокирует только невалидный ввод (false)
    if (editableUsername === false) return;

    if (!trimmedFirstName.length) {
      setError(ERROR_FIRST_NAME_MISSING);
      return;
    }

    if (isPhoneTouched) {
      setIsPhoneTouched(false);
      void updateParvaneProfile({ phone: phone.trim() });
      if (!photo && !isProfileFieldsTouched) return;
    }

    updateProfile({
      photo,
      ...(isProfileFieldsTouched && {
        firstName: trimmedFirstName,
        lastName: trimmedLastName,
        bio: trimmedBio,
      }),
      ...(isUsernameTouched && {
        username: editableUsername,
      }),
    });
  });

  return (
    <div className="settings-fab-wrapper">
      <Surface scrollable className="settings-content no-border">
        <IslandOutside className="settings-content-header">
          <AvatarEditable
            currentAvatarBlobUrl={currentAvatarBlobUrl}
            onChange={handlePhotoChange}
            title={lang('AriaSettingsEditProfilePhoto')}
            disabled={isLoading}
          />
        </IslandOutside>
        <Island>
          <div className="settings-input">
            <InputText
              value={firstName}
              onChange={handleFirstNameChange}
              label={oldLang('FirstName')}
              disabled={isLoading}
              error={error === ERROR_FIRST_NAME_MISSING ? error : undefined}
            />
            <InputText
              value={lastName}
              onChange={handleLastNameChange}
              label={oldLang('LastName')}
              disabled={isLoading}
            />
            <TextArea
              value={bio}
              onChange={handleBioChange}
              label={oldLang('UserBio')}
              disabled={isLoading}
              maxLength={maxBioLength}
              maxLengthIndicator={maxBioLength ? (maxBioLength - bio.length).toString() : undefined}
            />
          </div>
        </Island>
        <IslandDescription dir={oldLang.isRtl ? 'rtl' : undefined}>
          {renderText(oldLang('lng_settings_about_bio'), ['br', 'simple_markdown'])}
        </IslandDescription>

        <Island>
          <ListItem
            icon="gift"
            narrow
            rightElement={formattedBirthday ?
              <span className="settings-birthday-date">{formattedBirthday}</span>
              : undefined}
            onClick={handleBirthdayClick}
          >
            <span className="flex-grow">{lang('SettingsBirthday')}</span>
          </ListItem>
        </Island>
        {/* Parvane: настроек приватности даты рождения нет (серверной приватности нет) */}

        <Island>
          <ListItem
            icon="colorize"
            narrow
            className="parvane-name-color"
            rightElement={(
              <span
                className={buildClassName('parvane-name-color-swatch', `peer-color-${currentNameColor ?? 0}`)}
              />
            )}
            onClick={() => setIsColorPickerOpen(!isColorPickerOpen)}
          >
            <span className="flex-grow">{oldLang('ParvaneNameColor')}</span>
          </ListItem>
          {isColorPickerOpen && (
            <div className="parvane-name-color-palette">
              {Array.from({ length: PEER_COLOR_COUNT }, (_, index) => index + FIRST_SELECTABLE_COLOR).map((color) => (
                <button
                  key={color}
                  type="button"
                  className={buildClassName('parvane-name-color-option', `peer-color-${color}`)}
                  aria-label={`${oldLang('ParvaneNameColor')} ${color}`}
                  onClick={() => handleNameColorSelect(color)}
                />
              ))}
              <button type="button" className="parvane-name-color-default" onClick={() => handleNameColorSelect(-1)}>
                {oldLang('ParvaneNameColorDefault')}
              </button>
            </div>
          )}
          <ListItem
            icon="channel"
            narrow
            className="parvane-personal-channel"
            rightElement={currentPersonalChannelTitle
              ? <span className="settings-birthday-date">{currentPersonalChannelTitle}</span>
              : undefined}
            onClick={() => setIsChannelPickerOpen(true)}
          >
            <span className="flex-grow">{oldLang('ParvanePersonalChannel')}</span>
          </ListItem>
          {currentPersonalChannelId && (
            <ListItem icon="delete" narrow destructive onClick={handlePersonalChannelRemove}>
              <span className="flex-grow">{oldLang('ParvanePersonalChannelRemove')}</span>
            </ListItem>
          )}
          <div className="settings-input">
            <InputText
              value={phone}
              onChange={handlePhoneChange}
              label={oldLang('ParvanePhone')}
              disabled={isLoading}
            />
          </div>
        </Island>
        <ChatOrUserPicker
          isOpen={isChannelPickerOpen}
          chatOrUserIds={channelIds}
          title={oldLang('ParvanePersonalChannel')}
          searchPlaceholder={oldLang('Search')}
          search={channelSearch}
          onSearchChange={setChannelSearch}
          onSelectChatOrUser={handlePersonalChannelSelect}
          onClose={() => setIsChannelPickerOpen(false)}
        />

        {/* Parvane: username — ник из адреса, не редактируется (сервер его не хранит) */}
        <IslandTitle dir={oldLang.isRtl ? 'rtl' : undefined}>{oldLang('Username')}</IslandTitle>
        <Island>
          <div className="settings-input">
            <InputText
              value={readOnlyUsername ? `@${readOnlyUsername}` : ''}
              label={oldLang('Username')}
              readOnly
            />
          </div>
        </Island>
        {readOnlyUsername && (
          <IslandDescription dir={oldLang.isRtl ? 'rtl' : undefined}>
            {oldLang('lng_username_link')}
            <br />
            <span className="username-link">{buildParvaneUserLink(readOnlyUsername)}</span>
          </IslandDescription>
        )}

        {shouldRenderUsernamesManage && (
          <ManageUsernames
            usernames={usernames}
            onEditUsername={setEditableUsername}
          />
        )}
      </Surface>

      <FloatingActionButton
        isShown={isSaveButtonShown}
        onClick={handleProfileSave}
        disabled={isLoading}
        ariaLabel={oldLang('Save')}
        iconName="check"
        isLoading={isLoading}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { currentUserId } = global;
    const {
      progress, isUsernameAvailable, checkedUsername, error: editUsernameError,
    } = selectTabState(global).profileEdit || {};
    const currentUser = currentUserId ? selectUser(global, currentUserId) : undefined;

    const maxBioLength = selectCurrentLimit(global, 'aboutLength');

    const {
      firstName: currentFirstName,
      lastName: currentLastName,
      usernames,
    } = currentUser || {};
    const currentUserFullInfo = currentUserId ? selectUserFullInfo(global, currentUserId) : undefined;
    const currentAvatarHash = currentUser && getChatAvatarHash(currentUser);
    const currentPersonalChannelId = currentUserFullInfo?.personalChannelId;
    // Личный канал — любая своя группа/канал Parvane
    const channelIds = Object.values(global.chats.byId)
      .filter((chat) => chat.type === 'chatTypeChannel' || chat.type === 'chatTypeBasicGroup')
      .map((chat) => chat.id);

    return {
      currentAvatarHash,
      currentFirstName,
      currentLastName,
      currentBirthday: currentUserFullInfo?.birthday,
      currentBio: currentUserFullInfo?.bio,
      progress,
      isUsernameAvailable,
      checkedUsername,
      editUsernameError,
      maxBioLength,
      usernames,
      currentNameColor: currentUser?.color && 'color' in currentUser.color ? currentUser.color.color : undefined,
      currentPhone: currentUser?.phoneNumber,
      currentPersonalChannelId,
      currentPersonalChannelTitle: currentPersonalChannelId
        ? global.chats.byId[currentPersonalChannelId]?.title
        : undefined,
      channelIds,
    };
  },
)(SettingsEditProfile));
