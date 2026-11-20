import { memo, useEffect, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { SettingsScreens } from '../../../types';

import { selectIsCurrentUserFrozen } from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import PrivacySignIn from './profile/PrivacySignIn';
import ProfileChoiceSheet from './profile/ProfileChoiceSheet';
import ProfileIcon from './profile/ProfileIcon';
import ProfileSwitchRow from './profile/ProfileSwitchRow';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  blockedCount: number;
  canDisplayChatInTitle?: boolean;
  isCurrentUserFrozen?: boolean;
};

type Audience = 'anyone' | 'nobody';
type ChoiceRow = 'message' | 'call' | 'groups';
type CallPresencePolicy = {
  isAvailable: boolean; areCallsAllowed: boolean; isPresenceShown: boolean; isRelayOnly?: boolean;
};

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;
const CHOICE_ROWS: ChoiceRow[] = ['message', 'call', 'groups'];
// Начало отпечатка в строке, весь — в буфер обмена
const KEY_PREVIEW_LENGTH = 4;

// Parvane (spec 041 E3): «Профиль → Конфиденциальность» строками по доскам `PhProfileB`, `DkSettingsB`: «кто может»
// значением с выбором в шторке, выключатели, защита входа (`profile/PrivacySignIn.tsx`), шифрование. Настройки
// прежние: «писать мне» — сообщения от незнакомых (T079), «звонить мне» и «в сети» (FR-040), «добавлять в группы»
// (P-34), звонки через сервер — только это устройство. Сервер не принял — значение возвращается с уведомлением (B14)
const SettingsPrivacy = ({
  isActive,
  blockedCount,
  canDisplayChatInTitle,
  isCurrentUserFrozen,
  onReset,
}: OwnProps & StateProps) => {
  const {
    loadBlockedUsers, setSharedSettingOption, openSettingsScreen, showNotification,
  } = getActions();

  const lang = useLang();
  const oldLang = useOldLang();

  const [openChoice, setOpenChoice] = useState<ChoiceRow | undefined>();
  const [ownFingerprint, setOwnFingerprint] = useState('');
  // Согласие на добавление в группы: сервер отклоняет добавление без него
  const [isGroupAddAllowed, setIsGroupAddAllowed] = useState(true);
  const [strangers, setStrangers] = useState<{ isAvailable: boolean; isAllowed: boolean }>();
  const [callPresence, setCallPresence] = useState<CallPresencePolicy>();

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (!isCurrentUserFrozen) loadBlockedUsers();
  }, [isCurrentUserFrozen]);

  useEffect(() => {
    void (callParvane('parvaneGetGroupAddPolicy', {}) as Promise<{ policy: string } | undefined>)
      .then((state) => setIsGroupAddAllowed(state?.policy !== 'nobody'));
    void (callParvane('parvaneGetStrangersPolicy', {}) as Promise<{ isAvailable: boolean; isAllowed: boolean }>)
      .then(setStrangers);
    void (callParvane('parvaneGetCallPresencePolicy', {}) as Promise<CallPresencePolicy>).then(setCallPresence);
  }, []);

  useEffect(() => {
    if (!isActive) return undefined;
    let isCancelled = false;
    void (callParvane('parvaneFetchSecurityInfo', {}) as Promise<{ own: string } | undefined>)
      .then((info) => {
        if (!isCancelled && info) setOwnFingerprint(info.own);
      })
      .catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, [isActive]);

  const notifyPrivacyFailed = useLastCallback(() => {
    showNotification({ message: oldLang('ParvanePrivacySaveFailed') });
  });

  const handleGroupAddChange = useLastCallback((isAllowed: boolean) => {
    setIsGroupAddAllowed(isAllowed);
    void callParvane('parvaneSetGroupAddPolicy', { policy: isAllowed ? 'anyone' : 'nobody' }).then((isSaved) => {
      if (isSaved) return;
      setIsGroupAddAllowed(!isAllowed);
      notifyPrivacyFailed();
    });
  });

  const handleStrangersChange = useLastCallback((isAllowed: boolean) => {
    setStrangers({ isAvailable: true, isAllowed });
    void callParvane('parvaneSetStrangersPolicy', { isAllowed }).then((isSaved) => {
      if (isSaved) return;
      setStrangers({ isAvailable: true, isAllowed: !isAllowed });
      notifyPrivacyFailed();
    });
  });

  const handleCallsChange = useLastCallback((isAllowed: boolean) => {
    const isPresenceShown = callPresence?.isPresenceShown ?? true;
    setCallPresence((current) => ({ ...current, isAvailable: true, isPresenceShown, areCallsAllowed: isAllowed }));
    void callParvane('parvaneSetCallsPolicy', { isAllowed }).then((isSaved) => {
      if (isSaved) return;
      setCallPresence((current) => (current ? { ...current, areCallsAllowed: !isAllowed } : current));
      notifyPrivacyFailed();
    });
  });

  const handleRelayChange = useLastCallback((isRelayOnly: boolean) => {
    setCallPresence((current) => (current ? { ...current, isRelayOnly } : current));
    void callParvane('parvaneSetCallsRelay', { isRelayOnly });
  });

  const handlePresenceChange = useLastCallback((isShown: boolean) => {
    const areCallsAllowed = callPresence?.areCallsAllowed ?? true;
    setCallPresence((current) => ({ ...current, isAvailable: true, areCallsAllowed, isPresenceShown: isShown }));
    void callParvane('parvaneSetPresencePolicy', { isShown }).then((isSaved) => {
      if (isSaved) return;
      setCallPresence((current) => (current ? { ...current, isPresenceShown: !isShown } : current));
      notifyPrivacyFailed();
    });
  });

  const handleChoice = useLastCallback((value: string) => {
    const isAllowed = (value as Audience) === 'anyone';
    if (openChoice === 'message') handleStrangersChange(isAllowed);
    if (openChoice === 'call') handleCallsChange(isAllowed);
    if (openChoice === 'groups') handleGroupAddChange(isAllowed);
  });

  const handleCopyKey = useLastCallback(() => {
    if (!ownFingerprint) return;
    copyTextToClipboard(ownFingerprint);
    showNotification({ message: lang('ParvanePrivacyKeyCopied') });
  });

  const handleChatInTitleChange = useLastCallback((isOn: boolean) => {
    setSharedSettingOption({ canDisplayChatInTitle: isOn });
  });

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);
  const anyoneLabel = lang('ParvanePrivacyEveryone');
  const nobodyLabel = lang('ParvanePrivacyNobody');
  const choices: Record<ChoiceRow, { title: string; hint: string; isAllowed: boolean; nobody: string }> = {
    message: {
      title: lang('ParvanePrivacyMessageMe'),
      hint: oldLang('ParvaneStrangersInfo'),
      isAllowed: Boolean(strangers?.isAllowed),
      nobody: lang('ParvanePrivacyWrittenTo'),
    },
    call: {
      title: lang('ParvanePrivacyCallMe'),
      hint: oldLang('ParvaneCallsInfo'),
      isAllowed: Boolean(callPresence?.areCallsAllowed),
      nobody: nobodyLabel,
    },
    groups: {
      title: lang('ParvanePrivacyAddToGroups'),
      hint: oldLang('ParvaneGroupAddInfo'),
      isAllowed: isGroupAddAllowed,
      nobody: nobodyLabel,
    },
  };
  const visibleChoices = CHOICE_ROWS.filter((row) => (
    (row !== 'message' || strangers?.isAvailable) && (row !== 'call' || callPresence?.isAvailable)
  ));
  const sheet = openChoice ? choices[openChoice] : undefined;
  const sheetNobody = sheet?.nobody || nobodyLabel;
  const sheetOptions = useMemo(() => [
    { value: 'anyone', label: anyoneLabel },
    { value: 'nobody', label: sheetNobody },
  ], [anyoneLabel, sheetNobody]);

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-privacy>
      <div className={styles.caption}>{lang('ParvanePrivacyWhoCan')}</div>
      <div className={styles.group}>
        {visibleChoices.map((row) => (
          <button
            key={row}
            type="button"
            className={rowClass}
            data-privacy-row={row}
            onClick={() => setOpenChoice(row)}
          >
            <span className={styles.setTitle}>{choices[row].title}</span>
            <span className={styles.menuValue} data-privacy-value={choices[row].isAllowed ? 'anyone' : 'nobody'}>
              {choices[row].isAllowed ? anyoneLabel : choices[row].nobody}
            </span>
            <ProfileIcon name="right" isSmall className={styles.menuChevron} />
          </button>
        ))}
        {callPresence?.isAvailable && (
          <ProfileSwitchRow
            title={lang('ParvanePrivacyOnline')}
            isOn={callPresence.isPresenceShown}
            onChange={handlePresenceChange}
            data-privacy-row="online"
          />
        )}
        {callPresence?.isAvailable && (
          <ProfileSwitchRow
            title={lang('ParvanePrivacyRelay')}
            hint={lang('ParvanePrivacyRelayHint')}
            isOn={Boolean(callPresence.isRelayOnly)}
            onChange={handleRelayChange}
            data-privacy-row="relay"
          />
        )}
      </div>

      <PrivacySignIn isActive={isActive} />

      <div className={styles.caption}>{lang('ParvanePrivacyEncryption')}</div>
      <div className={styles.group}>
        <button
          type="button"
          className={rowClass}
          title={oldLang('ParvaneSecurityKeyOwnHint')}
          data-privacy-row="key"
          data-security-key={ownFingerprint}
          onClick={handleCopyKey}
        >
          <span className={styles.setTitle}>{oldLang('ParvaneSecurityKeyOwn')}</span>
          <span className={styles.setValue}>
            {ownFingerprint ? `${ownFingerprint.slice(0, KEY_PREVIEW_LENGTH)} …` : '…'}
          </span>
        </button>
        <button
          type="button"
          className={rowClass}
          data-privacy-row="blocked"
          onClick={() => openSettingsScreen({ screen: SettingsScreens.PrivacyBlockedUsers })}
        >
          <span className={styles.setTitle}>{oldLang('BlockedUsers')}</span>
          <span className={styles.menuValue}>{blockedCount}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
      </div>
      <div className={styles.hint}>{lang('ParvanePrivacyEncryptionHint')}</div>

      <div className={styles.caption}>{oldLang('lng_settings_window_system')}</div>
      <div className={styles.group}>
        <ProfileSwitchRow
          title={oldLang('lng_settings_title_chat_name')}
          isOn={Boolean(canDisplayChatInTitle)}
          onChange={handleChatInTitleChange}
          data-privacy-row="title"
        />
      </div>

      <ProfileChoiceSheet
        isOpen={Boolean(sheet)}
        title={sheet?.title || ''}
        hint={sheet?.hint}
        options={sheetOptions}
        selected={sheet?.isAllowed ? 'anyone' : 'nobody'}
        onSelect={handleChoice}
        onClose={() => setOpenChoice(undefined)}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { canDisplayChatInTitle } = selectSharedSettings(global);
    return {
      blockedCount: global.blocked.totalCount,
      canDisplayChatInTitle,
      isCurrentUserFrozen: selectIsCurrentUserFrozen(global),
    };
  },
)(SettingsPrivacy));
