import type { FC } from '../../lib/teact/teact';
import {
  memo, useCallback, useEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import { TME_LINK_PREFIX } from '../../config';
import {
  isUsernameValid, MAX_USERNAME_LENGTH, MIN_UPDATE_USERNAME_LENGTH, USERNAME_REGEX,
} from '../../util/entities/username';
import { debounce } from '../../util/schedulers';

import useOldLang from '../../hooks/useOldLang';
import usePreviousDeprecated from '../../hooks/usePreviousDeprecated';

import InputText from '../ui/InputText';

type OwnProps = {
  currentUsername?: string;
  asLink?: boolean;
  isLoading?: boolean;
  isUsernameAvailable?: boolean;
  checkedUsername?: string;
  // Parvane (spec 023): начало публичной ссылки вместо `https://t.me/`
  linkPrefix?: string;
  onChange: (value: string) => void;
};

const runDebouncedForCheckUsername = debounce((cb) => cb(), 250, false);

const UsernameInput: FC<OwnProps> = ({
  currentUsername,
  asLink,
  isLoading,
  isUsernameAvailable,
  checkedUsername,
  linkPrefix = TME_LINK_PREFIX,
  onChange,
}) => {
  const { checkUsername, checkPublicLink } = getActions();
  const [username, setUsername] = useState(currentUsername || '');

  const linkPrefixRegex = useMemo(() => (
    new RegExp(`^${linkPrefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}?`, 'i')
  ), [linkPrefix]);
  const lang = useOldLang();
  const langPrefix = asLink ? 'SetUrl' : 'Username';
  const label = asLink ? lang('SetUrlPlaceholder') : lang('Username');

  const previousIsUsernameAvailable = usePreviousDeprecated(isUsernameAvailable);
  const renderingIsUsernameAvailable = currentUsername !== username
    ? (isUsernameAvailable ?? previousIsUsernameAvailable) : undefined;
  const isChecking = username && currentUsername !== username && checkedUsername !== username;

  const [usernameSuccess, usernameError] = useMemo(() => {
    if (!username.length) {
      return [];
    }

    if (username.length < MIN_UPDATE_USERNAME_LENGTH) {
      return [undefined, lang(`${langPrefix}InvalidShort`)];
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      return [undefined, lang(`${langPrefix}InvalidLong`)];
    }
    if (!USERNAME_REGEX.test(username)) {
      return [undefined, lang(`${langPrefix}Invalid`)];
    }

    if (renderingIsUsernameAvailable === undefined || isChecking) {
      return [];
    }

    // Variable `isUsernameAvailable` is initialized with `undefined`, so a strict false check is required
    return [
      renderingIsUsernameAvailable ? lang(`${langPrefix}Available`, label) : undefined,
      renderingIsUsernameAvailable === false ? lang(`${langPrefix}InUse`) : undefined,
    ];
  }, [username, renderingIsUsernameAvailable, isChecking, lang, langPrefix, label]);

  useEffect(() => {
    setUsername(currentUsername || '');
  }, [asLink, currentUsername]);

  const handleUsernameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim();
    // Prevent prefix editing
    if (asLink && !value.match(linkPrefixRegex)) {
      if (!value.length) {
        setUsername('');
        onChange?.('');
      }
      return;
    }
    const newUsername = value.replace(linkPrefixRegex, '');

    setUsername(newUsername);

    const isValid = newUsername === '' ? true : isUsernameValid(newUsername, true);
    if (!isValid) return;

    onChange?.(newUsername);

    runDebouncedForCheckUsername(() => {
      if (newUsername !== currentUsername) {
        const check = asLink ? checkPublicLink : checkUsername;
        check({ username: newUsername });
      }
    });
  }, [asLink, checkPublicLink, checkUsername, currentUsername, linkPrefixRegex, onChange]);

  return (
    <InputText
      value={`${asLink ? linkPrefix : ''}${username}`}
      onChange={handleUsernameChange}
      label={isChecking ? lang('Checking') : label}
      error={usernameError}
      success={usernameSuccess}
      readOnly={isLoading}
      teactExperimentControlled
    />
  );
};

export default memo(UsernameInput);
