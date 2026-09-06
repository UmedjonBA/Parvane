import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { GlobalState } from '../../../global/types';
import { SettingsScreens } from '../../../types';

import {
  selectCanSetPasscode, selectIsCurrentUserFrozen,
  selectIsCurrentUserPremium,
} from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import Island, { IslandTitle } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';

// parvane* — кастомные методы провайдера вне типизированного Methods
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
      loadPrivacySettings({});
      loadWebAuthorizations();
      loadPasskeys();
    }
  }, [isCurrentUserFrozen]);

  useEffect(() => {
    if (isActive && !isCurrentUserFrozen) {
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

  const handleTwoFactorChange = useLastCallback(async (enabled: boolean) => {
    setIsTwoFactorBusy(true);
    try {
      const state = await (callParvane('parvaneSetTwoFactor', { enabled }) as Promise<TwoFactorState | undefined>);
      if (state) setTwoFactor(state);
    } catch {
      showNotification({ message: oldLang('ParvaneTwoFactorFailed') });
    } finally {
      setIsTwoFactorBusy(false);
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
