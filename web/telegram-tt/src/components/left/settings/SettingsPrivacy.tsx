import { memo, useEffect, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { SettingsScreens } from '../../../types';

import { selectIsCurrentUserFrozen } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import PrivacySignIn from './profile/PrivacySignIn';
import ProfileChoiceSheet from './profile/ProfileChoiceSheet';
import ProfileIcon from './profile/ProfileIcon';
import ProfileSwitchRow from './profile/ProfileSwitchRow';
import SecurityKeySheet from './profile/SecurityKeySheet';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  blockedCount: number;
  isCurrentUserFrozen?: boolean;
};

// «Только контакты» у звонков соблюдает клиент владельца (как и «никто», FR-040): сервер звонящего не видит
type Audience = 'anyone' | 'contacts' | 'nobody';
type ChoiceRow = 'message' | 'call' | 'groups';
type CallPresencePolicy = {
  isAvailable: boolean; callsFrom: Audience; isPresenceShown: boolean; isRelayOnly?: boolean;
};

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;
const CHOICE_ROWS: ChoiceRow[] = ['message', 'call', 'groups'];
const CHOICE_OPTIONS: Record<ChoiceRow, Audience[]> = {
  message: ['anyone', 'contacts'],
  call: ['anyone', 'contacts', 'nobody'],
  groups: ['anyone', 'nobody'],
};
// Начало отпечатка в строке, весь — в буфер обмена
const KEY_PREVIEW_LENGTH = 4;

// Parvane (spec 041 E3): «Профиль → Конфиденциальность» строками по доскам `PhProfileB`, `DkSettingsB`: «кто может»
// значением с выбором в шторке, выключатели, защита входа (`profile/PrivacySignIn.tsx`), шифрование. Настройки
// прежние: «писать мне» — сообщения от незнакомых (T079), «звонить мне» и «в сети» (FR-040), «добавлять в группы»
// (P-34), звонки через сервер — только это устройство. Сервер не принял — значение возвращается с уведомлением (B14)
const SettingsPrivacy = ({
  isActive,
  blockedCount,
  isCurrentUserFrozen,
  onReset,
}: OwnProps & StateProps) => {
  const {
    loadBlockedUsers, openSettingsScreen, showNotification,
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

  const handleCallsChange = useLastCallback((callsFrom: Audience) => {
    const isPresenceShown = callPresence?.isPresenceShown ?? true;
    const previous = callPresence?.callsFrom ?? 'anyone';
    setCallPresence((current) => ({ ...current, isAvailable: true, isPresenceShown, callsFrom }));
    void callParvane('parvaneSetCallsPolicy', { callsFrom }).then((isSaved) => {
      if (isSaved) return;
      setCallPresence((current) => (current ? { ...current, callsFrom: previous } : current));
      notifyPrivacyFailed();
    });
  });

  const handleRelayChange = useLastCallback((isRelayOnly: boolean) => {
    setCallPresence((current) => (current ? { ...current, isRelayOnly } : current));
    void callParvane('parvaneSetCallsRelay', { isRelayOnly });
  });

  const handlePresenceChange = useLastCallback((isShown: boolean) => {
    const callsFrom = callPresence?.callsFrom ?? 'anyone';
    setCallPresence((current) => ({ ...current, isAvailable: true, callsFrom, isPresenceShown: isShown }));
    void callParvane('parvaneSetPresencePolicy', { isShown }).then((isSaved) => {
      if (isSaved) return;
      setCallPresence((current) => (current ? { ...current, isPresenceShown: !isShown } : current));
      notifyPrivacyFailed();
    });
  });

  const handleChoice = useLastCallback((value: string) => {
    const isAllowed = value === 'anyone';
    if (openChoice === 'message') handleStrangersChange(isAllowed);
    if (openChoice === 'call') handleCallsChange(value as Audience);
    if (openChoice === 'groups') handleGroupAddChange(isAllowed);
  });

  // «Ваш ключ безопасности» открывает экран ключа (доска `RpProfileC`): код, «Скопировать», «Показать QR»
  const [isKeyOpen, setIsKeyOpen] = useState(false);
  const handleOpenKey = useLastCallback(() => {
    if (ownFingerprint) setIsKeyOpen(true);
  });
  const handleCloseKey = useLastCallback(() => setIsKeyOpen(false));

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);
  const labels = useMemo<Record<Audience, string>>(() => ({
    anyone: lang('ParvanePrivacyEveryone'),
    contacts: lang('ParvanePrivacyContacts'),
    nobody: lang('ParvanePrivacyNobody'),
  }), [lang]);
  // «Писать мне»: ограничение сервера — сообщения только от тех, кому писали вы; в Parvane это и есть контакты
  // (`store.isContact`: явно добавленные и все, с кем есть переписка), поэтому вариант назван «Только контакты»
  const choices: Record<ChoiceRow, { title: string; hint: string; value: Audience }> = {
    message: {
      title: lang('ParvanePrivacyMessageMe'),
      hint: lang('ParvanePrivacyMessageHint'),
      value: strangers?.isAllowed ? 'anyone' : 'contacts',
    },
    call: {
      title: lang('ParvanePrivacyCallMe'),
      hint: lang('ParvanePrivacyCallHint'),
      value: callPresence?.callsFrom ?? 'anyone',
    },
    groups: {
      title: lang('ParvanePrivacyAddToGroups'),
      hint: oldLang('ParvaneGroupAddInfo'),
      value: isGroupAddAllowed ? 'anyone' : 'nobody',
    },
  };
  const visibleChoices = CHOICE_ROWS.filter((row) => (
    (row !== 'message' || strangers?.isAvailable) && (row !== 'call' || callPresence?.isAvailable)
  ));
  const sheet = openChoice ? choices[openChoice] : undefined;
  const sheetOptions = useMemo(() => (
    openChoice ? CHOICE_OPTIONS[openChoice].map((value) => ({ value, label: labels[value] })) : []
  ), [openChoice, labels]);

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
            <span className={styles.menuValue} data-privacy-value={choices[row].value}>
              {labels[choices[row].value]}
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
          onClick={handleOpenKey}
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

      <SecurityKeySheet isOpen={isKeyOpen} fingerprint={ownFingerprint} onClose={handleCloseKey} />
      <ProfileChoiceSheet
        isOpen={Boolean(sheet)}
        title={sheet?.title || ''}
        hint={sheet?.hint}
        options={sheetOptions}
        selected={sheet?.value || 'anyone'}
        onSelect={handleChoice}
        onClose={() => setOpenChoice(undefined)}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return {
      blockedCount: global.blocked.totalCount,
      isCurrentUserFrozen: selectIsCurrentUserFrozen(global),
    };
  },
)(SettingsPrivacy));
