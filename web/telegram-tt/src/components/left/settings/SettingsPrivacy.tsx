import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { GlobalState } from '../../../global/types';
import { SettingsScreens } from '../../../types';

import {
  selectCanSetPasscode, selectIsCurrentUserFrozen,
  selectIsCurrentUserPremium,
} from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { copyTextToClipboard } from '../../../util/clipboard';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import Island, { IslandTitle } from '../../gili/layout/Island';
import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';

// parvane* — кастомные методы провайдера вне типизированного Methods
// Parvane: серверных MTProto-разделов (веб-сессии, passkeys, автоархив, TTL
// аккаунта) нет в контракте — экраны скрыты, запросы не отправляются
const IS_SERVER_SECURITY_SECTIONS_SUPPORTED = false as boolean;

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  isCurrentUserPremium?: boolean;
  hasPassword?: boolean;
  hasPasscode?: boolean;
  canSetPasscode?: boolean;
  blockedCount: number;
  webAuthCount: number;
  isSensitiveEnabled?: boolean;
  canChangeSensitive?: boolean;
  canDisplayAutoarchiveSetting: boolean;
  shouldArchiveAndMuteNewNonContact?: boolean;
  shouldNewNonContactPeersRequirePremium?: boolean;
  shouldChargeForMessages: boolean;
  canDisplayChatInTitle?: boolean;
  isCurrentUserFrozen?: boolean;
  needAgeVideoVerification?: boolean;
  privacy: GlobalState['settings']['privacy'];
  accountDaysTtl?: number;
  passkeyCount?: number;
  arePasskeysAvailable?: boolean;
};

const SettingsPrivacy = ({
  isActive,
  isCurrentUserPremium,
  hasPassword,
  hasPasscode,
  blockedCount,
  webAuthCount,
  passkeyCount,
  arePasskeysAvailable,
  isSensitiveEnabled,
  canChangeSensitive,
  canDisplayAutoarchiveSetting,
  shouldArchiveAndMuteNewNonContact,
  shouldNewNonContactPeersRequirePremium,
  shouldChargeForMessages,
  canDisplayChatInTitle,
  canSetPasscode,
  needAgeVideoVerification,
  privacy,
  isCurrentUserFrozen,
  accountDaysTtl,
  onReset,
}: OwnProps & StateProps) => {
  const {
    loadPrivacySettings,
    loadBlockedUsers,
    loadGlobalPrivacySettings,
    loadWebAuthorizations,
    setSharedSettingOption,
    openSettingsScreen,
    loadAccountDaysTtl,
    loadPasskeys,
  } = getActions();

  useEffect(() => {
    if (!isCurrentUserFrozen) {
      loadBlockedUsers();
      // Parvane: строки privacy-видимости, веб-сессии и passkeys скрыты — их
      // данные не грузим; loadPrivacySettings — это 13 вызовов
      // fetchPrivacySettings, метода нет в провайдере (api-missing в журнале)
      if (IS_SERVER_SECURITY_SECTIONS_SUPPORTED) {
        loadPrivacySettings({});
        loadWebAuthorizations();
        loadPasskeys();
      }
    }
  }, [isCurrentUserFrozen]);

  useEffect(() => {
    // Parvane: автоархив и удаление аккаунта по TTL скрыты — их данные не грузим
    if (IS_SERVER_SECURITY_SECTIONS_SUPPORTED && isActive && !isCurrentUserFrozen) {
      loadGlobalPrivacySettings();
      loadAccountDaysTtl();
    }
  }, [isActive, isCurrentUserFrozen]);

  const oldLang = useOldLang();
  const lang = useLang();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const { showNotification } = getActions();

  type TwoFactorState = { enabled: boolean; telegramLinked: boolean };
  const [twoFactor, setTwoFactor] = useState<TwoFactorState | undefined>();
  const [isTwoFactorBusy, setIsTwoFactorBusy] = useState(false);

  useEffect(() => {
    if (!isActive) return;
    let isCancelled = false;
    void (callParvane('parvaneFetchTwoFactor', undefined) as Promise<TwoFactorState | undefined>)
      .then((state) => {
        if (!isCancelled && state) setTwoFactor(state);
      })
      .catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, [isActive]);

  const [ownFingerprint, setOwnFingerprint] = useState('');
  useEffect(() => {
    if (!isActive) return;
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

  const handleCopyOwnKey = useLastCallback(() => {
    if (ownFingerprint) copyTextToClipboard(ownFingerprint);
  });

  // P-07: выключение 2FA требует текущий пароль — показываем поле ввода и
  // отправляем пароль вместе с запросом (один украденный JWT второй фактор не
  // снимет). Включение — как раньше, по JWT.
  const [disablePassword, setDisablePassword] = useState('');
  const [isDisablePromptOpen, setIsDisablePromptOpen] = useState(false);

  const applyTwoFactor = useLastCallback(async (enabled: boolean, password?: string) => {
    setIsTwoFactorBusy(true);
    try {
      const state = await (
        callParvane('parvaneSetTwoFactor', { enabled, password }) as Promise<TwoFactorState | undefined>
      );
      if (state) setTwoFactor(state);
      setIsDisablePromptOpen(false);
      setDisablePassword('');
    } catch {
      showNotification({ message: oldLang('ParvaneTwoFactorFailed') });
    } finally {
      setIsTwoFactorBusy(false);
    }
  });

  const handleTwoFactorChange = useLastCallback((enabled: boolean) => {
    if (!enabled) {
      setIsDisablePromptOpen(true);
      return;
    }
    void applyTwoFactor(true);
  });

  const handleConfirmDisable = useLastCallback(() => {
    if (!disablePassword) return;
    void applyTwoFactor(false, disablePassword);
  });

  // P-07: смена пароля (identity.password.change) — старый + новый (≥ 8 символов).
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordRepeat, setNewPasswordRepeat] = useState('');
  const [isPasswordBusy, setIsPasswordBusy] = useState(false);
  const canChangePassword = Boolean(oldPassword) && newPassword.length >= 8 && newPassword === newPasswordRepeat;

  const handleChangePassword = useLastCallback(async () => {
    if (!canChangePassword) return;
    setIsPasswordBusy(true);
    try {
      await callParvane('parvaneChangePassword', { oldPassword, newPassword });
      setOldPassword('');
      setNewPassword('');
      setNewPasswordRepeat('');
      showNotification({ message: oldLang('ParvaneChangePasswordDone') });
    } catch (error) {
      const reason = String((error as Error)?.message || error);
      showNotification({ message: `${oldLang('ParvaneChangePasswordFailed')}: ${reason}` });
    } finally {
      setIsPasswordBusy(false);
    }
  });

  // P-34: согласие на добавление в группы (сервер отклоняет add без него)
  const [allowGroupAdd, setAllowGroupAdd] = useState(true);
  useEffect(() => {
    void (callParvane('parvaneGetGroupAddPolicy', {}) as Promise<{ policy: string } | undefined>)
      .then((state) => setAllowGroupAdd(state?.policy !== 'nobody'));
  }, []);
  const handleGroupAddChange = useLastCallback((allowed: boolean) => {
    setAllowGroupAdd(allowed);
    void callParvane('parvaneSetGroupAddPolicy', { policy: allowed ? 'anyone' : 'nobody' });
  });

  // Протокол v2 (spec 007, T079): сообщения от незнакомых (анонимные жетоны)
  const [strangers, setStrangers] = useState<{ isAvailable: boolean; isAllowed: boolean }>();
  useEffect(() => {
    void (callParvane('parvaneGetStrangersPolicy', {}) as Promise<{ isAvailable: boolean; isAllowed: boolean }>)
      .then(setStrangers);
  }, []);
  // Parvane: «кто может звонить» и «кто видит, что я в сети» (FR-040)
  type CallPresencePolicy = { isAvailable: boolean; areCallsAllowed: boolean; isPresenceShown: boolean };
  const [callPresence, setCallPresence] = useState<CallPresencePolicy>();
  useEffect(() => {
    void (callParvane('parvaneGetCallPresencePolicy', {}) as Promise<CallPresencePolicy>).then(setCallPresence);
  }, []);
  const handleCallsChange = useLastCallback((isAllowed: boolean) => {
    const isPresenceShown = callPresence?.isPresenceShown ?? true;
    setCallPresence({ isAvailable: true, isPresenceShown, areCallsAllowed: isAllowed });
    void callParvane('parvaneSetCallsPolicy', { isAllowed });
  });
  const handlePresenceChange = useLastCallback((isShown: boolean) => {
    const areCallsAllowed = callPresence?.areCallsAllowed ?? true;
    setCallPresence({ isAvailable: true, areCallsAllowed, isPresenceShown: isShown });
    void callParvane('parvaneSetPresencePolicy', { isShown });
  });
  const handleStrangersChange = useLastCallback((isAllowed: boolean) => {
    setStrangers({ isAvailable: true, isAllowed });
    void callParvane('parvaneSetStrangersPolicy', { isAllowed });
  });

  // P-39: опциональный PIN хранилища (E2E-ключи + сохранённая сессия).
  const [storagePin, setStoragePin] = useState('');
  const [storagePinRepeat, setStoragePinRepeat] = useState('');
  const [isPinBusy, setIsPinBusy] = useState(false);
  const [isPinEnabled, setIsPinEnabled] = useState(false);
  useEffect(() => {
    void (callParvane('parvaneGetStoragePin', {}) as Promise<{ enabled: boolean } | undefined>)
      .then((state) => setIsPinEnabled(Boolean(state?.enabled)));
  }, []);
  const canSetPin = storagePin.length >= 4 && storagePin === storagePinRepeat;

  const applyStoragePin = useLastCallback(async (pin: string) => {
    setIsPinBusy(true);
    try {
      const ok = await callParvane('parvaneSetStoragePin', { pin });
      if (!ok) throw new Error('rejected');
      setIsPinEnabled(Boolean(pin));
      setStoragePin('');
      setStoragePinRepeat('');
      showNotification({ message: oldLang('ParvaneStoragePinDone') });
    } catch {
      showNotification({ message: oldLang('ParvaneStoragePinFailed') });
    } finally {
      setIsPinBusy(false);
    }
  });

  const handleExportE2eKeys = useLastCallback(async () => {
    const password = window.prompt(oldLang('ParvaneKeysPasswordPrompt'));
    if (!password) return;
    const result = await callParvane('parvaneExportE2eKeys', { password }) as { payload: string } | undefined;
    if (!result) {
      showNotification({ message: oldLang('ParvaneKeysExportFailed') });
      return;
    }
    const blob = new Blob([result.payload], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'parvane-e2e-keys.json';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    showNotification({ message: oldLang('ParvaneKeysExported') });
  });

  const handleImportE2eKeys = useLastCallback(() => {
    openSystemFilesDialog('.json', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      void (async () => {
        const password = window.prompt(oldLang('ParvaneKeysPasswordPrompt'));
        if (!password) return;
        const payload = await file.text();
        const result = await callParvane('parvaneImportE2eKeys', { payload, password });
        showNotification({
          message: oldLang(result ? 'ParvaneKeysImported' : 'ParvaneKeysImportFailed'),
        });
      })();
    }, true);
  });

  const handleChatInTitleChange = useLastCallback((isChecked: boolean) => {
    setSharedSettingOption({
      canDisplayChatInTitle: isChecked,
    });
  });

  return (
    <div className="settings-content custom-scroll">
      <Island>
        <ListItem
          icon="delete-user"
          narrow
          onClick={() => openSettingsScreen({ screen: SettingsScreens.PrivacyBlockedUsers })}
        >
          {oldLang('BlockedUsers')}
          <span className="settings-item__current-value">{blockedCount || ''}</span>
        </ListItem>
        <ListItem icon="key" narrow onClick={handleExportE2eKeys}>
          {oldLang('ParvaneExportKeys')}
        </ListItem>
        <ListItem icon="download" narrow onClick={handleImportE2eKeys}>
          {oldLang('ParvaneImportKeys')}
        </ListItem>
      </Island>

      {/* Parvane: скрыты серверные MTProto-разделы — Passcode/2FA/Passkeys/
          Web Sessions, privacy-видимость (номер/last seen/фото/bio/…),
          sensitive-контент, автоархив и удаление аккаунта по TTL */}

      {/* Parvane: свой ключ безопасности — отпечаток identity-ключа устройства */}
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
        {oldLang('ParvaneSecurityKeyOwn')}
      </IslandTitle>
      <Island>
        <ListItem icon="key" narrow multiline onClick={handleCopyOwnKey}>
          <span className="title" style="font-family: var(--font-monospace); font-size: 0.875rem">
            {ownFingerprint || '…'}
          </span>
          <span className="subtitle">{oldLang('ParvaneSecurityKeyOwnHint')}</span>
        </ListItem>
      </Island>

      {/* Parvane: двухфакторный вход — подтверждение в привязанном Telegram */}
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
        {oldLang('ParvaneTwoFactorTitle')}
      </IslandTitle>
      <Island>
        <Checkbox
          label={oldLang('ParvaneTwoFactorToggle')}
          subLabel={twoFactor && !twoFactor.telegramLinked
            ? oldLang('ParvaneTwoFactorNoTelegram')
            : oldLang('ParvaneTwoFactorInfo')}
          checked={Boolean(twoFactor?.enabled)}
          disabled={!twoFactor || !twoFactor.telegramLinked || isTwoFactorBusy}
          onCheck={handleTwoFactorChange}
        />
        {isDisablePromptOpen && (
          <div className="settings-item">
            <input
              type="password"
              className="form-control"
              placeholder={oldLang('ParvanePasswordConfirm')}
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.currentTarget.value)}
              disabled={isTwoFactorBusy}
            />
            <Button size="smaller" disabled={!disablePassword || isTwoFactorBusy} onClick={handleConfirmDisable}>
              {oldLang('ParvaneTwoFactorDisableConfirm')}
            </Button>
          </div>
        )}
      </Island>

      {/* Parvane: смена пароля (P-07) */}
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
        {oldLang('ParvaneChangePasswordTitle')}
      </IslandTitle>
      <Island>
        <div className="settings-item">
          <input
            type="password"
            className="form-control"
            placeholder={oldLang('ParvaneChangePasswordOld')}
            value={oldPassword}
            onChange={(e) => setOldPassword(e.currentTarget.value)}
            disabled={isPasswordBusy}
          />
          <input
            type="password"
            className="form-control"
            placeholder={oldLang('ParvaneChangePasswordNew')}
            value={newPassword}
            onChange={(e) => setNewPassword(e.currentTarget.value)}
            disabled={isPasswordBusy}
          />
          <input
            type="password"
            className="form-control"
            placeholder={oldLang('ParvaneChangePasswordRepeat')}
            value={newPasswordRepeat}
            onChange={(e) => setNewPasswordRepeat(e.currentTarget.value)}
            disabled={isPasswordBusy}
          />
          <Button size="smaller" disabled={!canChangePassword || isPasswordBusy} onClick={handleChangePassword}>
            {oldLang('ParvaneChangePasswordButton')}
          </Button>
        </div>
      </Island>

      {/* Parvane: кто может добавлять меня в группы (P-34) */}
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
        {oldLang('ParvaneGroupAddTitle')}
      </IslandTitle>
      <Island>
        <Checkbox
          label={oldLang('ParvaneGroupAddToggle')}
          subLabel={oldLang('ParvaneGroupAddInfo')}
          checked={allowGroupAdd}
          onCheck={handleGroupAddChange}
        />
        {strangers?.isAvailable && (
          <Checkbox
            label={oldLang('ParvaneStrangersToggle')}
            subLabel={oldLang('ParvaneStrangersInfo')}
            checked={strangers.isAllowed}
            onCheck={handleStrangersChange}
          />
        )}
        {callPresence?.isAvailable && (
          <Checkbox
            label={oldLang('ParvaneCallsToggle')}
            subLabel={oldLang('ParvaneCallsInfo')}
            checked={callPresence.areCallsAllowed}
            onCheck={handleCallsChange}
          />
        )}
        {callPresence?.isAvailable && (
          <Checkbox
            label={oldLang('ParvanePresenceToggle')}
            subLabel={oldLang('ParvanePresenceInfo')}
            checked={callPresence.isPresenceShown}
            onCheck={handlePresenceChange}
          />
        )}
      </Island>

      {/* Parvane: PIN хранилища E2E-ключей и сессии (P-39) */}
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
        {oldLang('ParvaneStoragePinTitle')}
      </IslandTitle>
      <Island>
        <p className="settings-item-description-larger">
          {isPinEnabled ? oldLang('ParvaneStoragePinEnabled') : oldLang('ParvaneStoragePinInfo')}
        </p>
        {isPinEnabled ? (
          <div className="settings-item">
            <Button size="smaller" disabled={isPinBusy} onClick={() => applyStoragePin('')}>
              {oldLang('ParvaneStoragePinRemove')}
            </Button>
          </div>
        ) : (
          <div className="settings-item">
            <input
              type="password"
              className="form-control"
              placeholder={oldLang('ParvaneStoragePinPlaceholder')}
              value={storagePin}
              onChange={(e) => setStoragePin(e.currentTarget.value)}
              disabled={isPinBusy}
            />
            <input
              type="password"
              className="form-control"
              placeholder={oldLang('ParvaneStoragePinRepeat')}
              value={storagePinRepeat}
              onChange={(e) => setStoragePinRepeat(e.currentTarget.value)}
              disabled={isPinBusy}
            />
            <Button size="smaller" disabled={!canSetPin || isPinBusy} onClick={() => applyStoragePin(storagePin)}>
              {oldLang('ParvaneStoragePinSet')}
            </Button>
          </div>
        )}
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
        {oldLang('lng_settings_window_system')}
      </IslandTitle>
      <Island>
        <Checkbox
          label={oldLang('lng_settings_title_chat_name')}
          checked={Boolean(canDisplayChatInTitle)}
          onCheck={handleChatInTitleChange}
        />
      </Island>

    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const {
      settings: {
        byKey: {
          hasPassword, isSensitiveEnabled, canChangeSensitive, shouldArchiveAndMuteNewNonContact,
          shouldNewNonContactPeersRequirePremium, nonContactPeersPaidStars,
        },
        privacy,
        accountDaysTtl,
        passkeys,
      },
      blocked,
      passcode: {
        hasPasscode,
      },
      appConfig,
    } = global;

    const { canDisplayChatInTitle } = selectSharedSettings(global);
    const shouldChargeForMessages = Boolean(nonContactPeersPaidStars);
    const isCurrentUserFrozen = selectIsCurrentUserFrozen(global);
    const isCurrentUserPremium = selectIsCurrentUserPremium(global);

    return {
      isCurrentUserPremium,
      hasPassword,
      hasPasscode: Boolean(hasPasscode),
      blockedCount: blocked.totalCount,
      webAuthCount: global.activeWebSessions.orderedHashes.length,
      isSensitiveEnabled,
      canDisplayAutoarchiveSetting: appConfig.canDisplayAutoarchiveSetting || isCurrentUserPremium,
      shouldArchiveAndMuteNewNonContact,
      canChangeSensitive,
      shouldNewNonContactPeersRequirePremium,
      shouldChargeForMessages,
      needAgeVideoVerification: Boolean(appConfig.needAgeVideoVerification),
      privacy,
      canDisplayChatInTitle,
      canSetPasscode: selectCanSetPasscode(global),
      isCurrentUserFrozen,
      accountDaysTtl,
      passkeyCount: passkeys?.length,
      arePasskeysAvailable: appConfig.arePasskeysAvailable,
    };
  },
)(SettingsPrivacy));
