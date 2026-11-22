import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiBirthday, ApiPhoto, ApiUsername } from '../../../api/types';
import type { NickSubmit } from './account/ProfileNickChange';
import { ApiMediaFormat } from '../../../api/types';
import { ProfileEditProgress } from '../../../types';

import { getChatAvatarHash } from '../../../global/helpers';
import { selectTabState, selectUser, selectUserFullInfo } from '../../../global/selectors';
import { selectCurrentLimit } from '../../../global/selectors/limits';
import buildClassName from '../../../util/buildClassName';
import { formatDateToString } from '../../../util/dates/oldDateFormat';
import { throttle } from '../../../util/schedulers';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';
import { buildParvaneUserLink } from '../../common/helpers/formatUsername';
import { setProfileSaveHandler } from './profile/profileRequests';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMedia from '../../../hooks/useMedia';
import useOldLang from '../../../hooks/useOldLang';
import usePreviousDeprecated from '../../../hooks/usePreviousDeprecated';

import ManageUsernames from '../../common/ManageUsernames';
import ChatOrUserPicker from '../../common/pickers/ChatOrUserPicker';
import Island, { IslandDescription, IslandOutside } from '../../gili/layout/Island';
import Surface from '../../gili/layout/Surface';
import CropModal from '../../ui/CropModal';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import ProfileNickChange from './account/ProfileNickChange';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './account/Account.module.scss';

type OwnProps = {
  isActive: boolean;
  // Окно поверх «Профиля» на компьютере (доска `RdProfile`): «Отмена / Сохранить» внизу, перетаскивание картинки
  isWindow?: boolean;
  onReset: () => void;
};

type StateProps = {
  currentAvatarHash?: string;
  currentAvatarPhotoId?: string;
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
const PHOTO_TYPES = 'image/png, image/jpeg';

// Parvane (spec 041, доски `XpProfile`, `RdProfile`): «Мой профиль» — фото («Сменить фото», «Убрать фото», картинку
// можно перетащить), «Имя», «О себе», ник своим блоком (`ProfileNickChange`: «Свободен», пароль при новом нике) и одна
// «Готово» / «Сохранить» для всего, в том числе ника. Поля, которых нет на досках (фамилия, день рождения, цвет имени,
// личный канал, телефон), — ниже под «Ещё». На телефоне — экран с «Готово» в шапке, на компьютере — окно
const SettingsEditProfile = ({
  isActive,
  isWindow,
  currentAvatarHash,
  currentAvatarPhotoId,
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
    deleteProfilePhoto,
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
  const [pickedPhoto, setPickedPhoto] = useState<File | undefined>();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const nickSubmitRef = useRef<NickSubmit | undefined>();
  const [hasNickChange, setHasNickChange] = useState(false);
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

    return Boolean(photo) || isProfileFieldsTouched || isPhoneTouched || hasNickChange
      || (isUsernameTouched && renderingIsUsernameAvailable === true);
  }, [
    isUsernameError, photo, isProfileFieldsTouched, isPhoneTouched, isUsernameTouched, renderingIsUsernameAvailable,
    hasNickChange,
  ]);

  const photoPreviewUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : undefined), [photo]);
  useEffect(() => () => {
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  }, [photoPreviewUrl]);

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
    setPickedPhoto(undefined);
    setPhoto(newPhoto);
  });

  const closeCrop = useLastCallback(() => setPickedPhoto(undefined));

  const handlePickPhoto = useLastCallback(() => {
    openSystemFilesDialog(PHOTO_TYPES, (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) setPickedPhoto(file);
    });
  });

  // Картинку можно перетащить в окно (доска `RdProfile`): дальше — та же обрезка, что у «Сменить фото»
  const handleDragOver = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    setIsDragOver(true);
  });

  const handleDragLeave = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  });

  const handleDrop = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    setIsDragOver(false);
    const file = Array.from(e.dataTransfer?.files || []).find(({ type }) => type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    setPickedPhoto(file);
  });

  const handleNickSubmitChange = useLastCallback((submit: NickSubmit | undefined) => {
    nickSubmitRef.current = submit;
    setHasNickChange(Boolean(submit));
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

  const handleAvatarRemove = useLastCallback(() => {
    // Фото у аккаунта одно: провайдер снимает его по идентификатору текущего (`deleteProfilePhotos`)
    deleteProfilePhoto({ photo: { id: currentAvatarPhotoId! } as ApiPhoto });
  });

  // Сохранить профиль; `false` — сохранять нечего либо имя пустое
  const handleProfileSave = useLastCallback(() => {
    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();
    const trimmedBio = bio.trim();

    // Parvane: у пользователей нет username — пустая строка не должна блокировать
    // сохранение; блокирует только невалидный ввод (false)
    if (editableUsername === false) return false;

    if (!trimmedFirstName.length) {
      setError(ERROR_FIRST_NAME_MISSING);
      return false;
    }

    if (isPhoneTouched) {
      setIsPhoneTouched(false);
      void updateParvaneProfile({ phone: phone.trim() });
    }
    if (!photo && !isProfileFieldsTouched && !isUsernameTouched) return true;

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
    return true;
  });

  // «Готово» шапки и «Сохранить» окна: профиль, затем ник (после смены ника вкладка перезагрузится); нечего
  // сохранять — назад. Окно закрывается после удачного сохранения
  const handleDone = useLastCallback(async () => {
    if (!isSaveButtonShown || isLoading) {
      onReset();
      return;
    }
    if (!handleProfileSave()) return;
    const submitNick = nickSubmitRef.current;
    if (submitNick && !await submitNick()) return;
    if (isWindow && !submitNick) onReset();
  });

  // Окно: «Отмена» не сохраняет — набранное забывается
  const handleCancel = useLastCallback(() => {
    areProfileFieldsDirtyRef.current = false;
    setFirstName(currentFirstName || '');
    setLastName(currentLastName || '');
    setBio(currentBio || '');
    setPhoto(undefined);
    setIsProfileFieldsTouched(false);
    setIsPhoneTouched(false);
    onReset();
  });

  useLayoutEffect(() => {
    if (!isActive || isWindow) return undefined;
    setProfileSaveHandler(handleDone);
    return () => setProfileSaveHandler(undefined);
  }, [isActive, isWindow, handleDone]);

  const avatarUrl = photoPreviewUrl || currentAvatarBlobUrl;
  const nameField = (
    <InputText
      value={firstName}
      onChange={handleFirstNameChange}
      label={oldLang('FirstName')}
      disabled={isLoading}
      error={error === ERROR_FIRST_NAME_MISSING ? error : undefined}
    />
  );
  // Ник своим блоком: смена (spec 026) с паролем — по общей «Готово» / «Сохранить»
  const nickBlock = (
    <ProfileNickChange
      currentNick={readOnlyUsername}
      leading={isWindow ? nameField : undefined}
      onSubmitChange={handleNickSubmitChange}
    />
  );

  return (
    <div
      className={buildClassName('settings-fab-wrapper', isDragOver && styles.dropActive)}
      data-edit-profile
      data-edit-profile-window={isWindow || undefined}
      data-dirty={isSaveButtonShown ? '' : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Surface scrollable className="settings-content no-border">
        <IslandOutside className={buildClassName(isWindow && 'settings-content-header', styles.avatarEdit)}>
          <span className={styles.avatarImage} data-avatar-image>
            {avatarUrl
              ? <img className={styles.avatarImg} src={avatarUrl} alt="" draggable={false} />
              : (firstName || '?').slice(0, 1)}
          </span>
          <span className={styles.avatarActions}>
            <button
              type="button"
              className={kit.btn}
              disabled={isLoading}
              data-avatar-change
              onClick={handlePickPhoto}
            >
              {lang('ParvaneProfileChangePhoto')}
            </button>
            {currentAvatarPhotoId && !photo && (
              <button
                type="button"
                className={buildClassName(kit.btn, kit.btnGhost)}
                data-avatar-remove
                onClick={handleAvatarRemove}
              >
                {lang('ParvaneProfileRemovePhoto')}
              </button>
            )}
            {isWindow && <span className={styles.muted}>{lang('ParvaneProfileDropHint')}</span>}
          </span>
        </IslandOutside>
        {/* Телефон (доска `XpProfile`): подпись над полем, поле на фоне */}
        {!isWindow && (
          <div className={styles.plainField}>
            <label className={styles.label} htmlFor="parvane-profile-name">{oldLang('FirstName')}</label>
            <input
              id="parvane-profile-name"
              className={kit.input}
              value={firstName}
              disabled={isLoading}
              aria-invalid={error === ERROR_FIRST_NAME_MISSING || undefined}
              data-profile-name
              onChange={handleFirstNameChange}
            />
            {error === ERROR_FIRST_NAME_MISSING && <div className={kit.fieldError} role="alert">{error}</div>}
          </div>
        )}
        {/* Окно компьютера (`RdProfile`): «Имя | Ник» строкой, затем «О себе»; телефон (`XpProfile`): имя, о себе, ник */}
        {isWindow && nickBlock}
        <div className={isWindow ? buildClassName(kit.card, styles.nickBox) : styles.plainField}>
          <label className={styles.label} htmlFor="parvane-profile-bio">{oldLang('UserBio')}</label>
          <textarea
            id="parvane-profile-bio"
            className={buildClassName(kit.textarea, styles.area)}
            value={bio}
            placeholder={lang('ParvaneProfileBioPlaceholder')}
            maxLength={maxBioLength || undefined}
            disabled={isLoading}
            onChange={handleBioChange}
          />
        </div>
        {!isWindow && nickBlock}

        <button
          type="button"
          className={styles.moreToggle}
          aria-expanded={isMoreOpen}
          data-profile-more
          onClick={() => setIsMoreOpen(!isMoreOpen)}
        >
          {lang('ParvaneProfileMoreFields')}
        </button>
        {isMoreOpen && (
          <>
            <Island>
              <div className="settings-input">
                <InputText
                  value={lastName}
                  onChange={handleLastNameChange}
                  label={oldLang('LastName')}
                  disabled={isLoading}
                />
              </div>
            </Island>
            {readOnlyUsername && (
              <IslandDescription>
                {oldLang('lng_username_link')}
                <br />
                <span className="username-link">{buildParvaneUserLink(readOnlyUsername)}</span>
              </IslandDescription>
            )}
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
                  {Array.from(
                    { length: PEER_COLOR_COUNT }, (_, index) => index + FIRST_SELECTABLE_COLOR,
                  ).map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={buildClassName('parvane-name-color-option', `peer-color-${color}`)}
                      aria-label={`${oldLang('ParvaneNameColor')} ${color}`}
                      onClick={() => handleNameColorSelect(color)}
                    />
                  ))}
                  <button
                    type="button"
                    className="parvane-name-color-default"
                    onClick={() => handleNameColorSelect(-1)}
                  >
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
          </>
        )}

        {shouldRenderUsernamesManage && (
          <ManageUsernames
            usernames={usernames}
            onEditUsername={setEditableUsername}
          />
        )}
      </Surface>
      {isWindow && (
        <div className={styles.windowFooter}>
          <button type="button" className={kit.btn} data-profile-cancel onClick={handleCancel}>
            {oldLang('Cancel')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={isLoading}
            data-profile-save
            onClick={handleDone}
          >
            {lang('ParvaneProfileSave')}
          </button>
        </div>
      )}
      <CropModal file={pickedPhoto} onClose={closeCrop} onChange={handlePhotoChange} />
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
      currentAvatarPhotoId: currentUser?.avatarPhotoId,
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
