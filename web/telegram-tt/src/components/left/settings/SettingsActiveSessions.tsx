import {
  memo, useEffect, useLayoutEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiSession } from '../../../api/types';
import type { GlobalState } from '../../../global/types';
import type { KeyDialogMode } from './devices/DeviceDialogs';
import type { StolenTarget } from './devices/DeviceStolenWizard';
import type { DeviceTitle } from './devices/deviceTitle';
import type { LinkOffer } from './devices/useDeviceLink';
import type { ProfileIconName } from './profile/ProfileIcon';
import { SettingsScreens } from '../../../types';

import { PARVANE_LEGACY_APP_VERSION } from '../../../config';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { setIsConfirmSignInScreen } from './devices/confirmSignInScreen';
import { buildDeviceTitle, formatSeenAt, parseDeviceLabel } from './devices/deviceTitle';
import useDeviceLink from './devices/useDeviceLink';
import { getKeysBackupSavedAt } from './profile/profileStatus';

import useAppLayout from '../../../hooks/useAppLayout';
import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import PvSheet from '../../parvane/notes/PvSheet';
import ConfirmDialog from '../../ui/ConfirmDialog';
import SecretForm from '../../ui/SecretForm';
import AccountCards from './account/AccountCards';
import DeviceConfirmSignIn from './devices/DeviceConfirmSignIn';
import { DeviceKeyDialog, ResetIdentityDialog } from './devices/DeviceDialogs';
import DeviceStolenWizard from './devices/DeviceStolenWizard';
import ProfileIcon from './profile/ProfileIcon';
import SessionSignOutMode, { type SignOutMode } from './SessionSignOutMode';
import SettingsActiveSession from './SettingsActiveSession';

import styles from './devices/Devices.module.scss';
import profile from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = Pick<GlobalState['activeSessions'], 'byHash' | 'orderedHashes'> & {
  currentUserId?: string;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const DEVICE_ID_PREVIEW = 8;
const KIND_KEYS = {
  phone: 'ParvaneDeviceKindPhone',
  computer: 'ParvaneDeviceKindComputer',
  browser: 'ParvaneDeviceKindBrowser',
} as const;
const KIND_ICONS: Record<DeviceTitle['kind'], ProfileIconName> = {
  phone: 'phone', computer: 'laptop', browser: 'globe',
};

// Parvane (spec 041 E3): «Профиль → Устройства» по доскам `PhProfileA`, `DkSettingsA`: запрос нового своего
// устройства карточкой с кодом сверки («Отклонить» — отказ на сервере, новое устройство о нём узнаёт), список
// устройств с «Выйти на нём» и «Украдено» (мастер `devices/DeviceStolenWizard.tsx` — и для живых сеансов, и для
// вышедших сами), «Привязать новое устройство», «Завершить другие сеансы», ключи. Это устройство ещё не подтверждено —
// «Подтвердите вход» (`devices/DeviceConfirmSignIn.tsx`; на телефоне — без остального экрана, доска `PhAuth`).
// Действия прежние: провайдер (LINK-1, RECOVER-1/2, REVOKE-1, P-07 — отзыв устройства только с текущим паролем)
const SettingsActiveSessions = ({
  isActive,
  onReset,
  byHash,
  orderedHashes,
  currentUserId,
}: OwnProps & StateProps) => {
  const { terminateAllAuthorizations, showNotification, openSettingsScreen } = getActions();

  const lang = useLang();
  const oldLang = useOldLang();
  const { isMobile } = useAppLayout();
  const {
    linkStatus, linkOffers, sskState, leftDevices, refresh,
  } = useDeviceLink(isActive);

  const [openedSessionHash, setOpenedSessionHash] = useState<string | undefined>();
  const [isTerminateAllOpen, openTerminateAll, closeTerminateAll] = useFlag();
  const [terminateAllPassword, setTerminateAllPassword] = useState('');
  const [terminateAllMode, setTerminateAllMode] = useState<SignOutMode>('keep');
  const [isLinkSheetOpen, openLinkSheet, closeLinkSheet] = useFlag();
  const [keyDialogMode, setKeyDialogMode] = useState<KeyDialogMode | undefined>();
  const [isResetOpen, openReset, closeReset] = useFlag();
  const [stolenTarget, setStolenTarget] = useState<StolenTarget | undefined>();
  // «Отклонить» ушёл серверу — до следующего опроса запрос здесь уже не показывается
  const [declinedOffers, setDeclinedOffers] = useState<string[]>([]);
  // «Копия ключей · сохранена» (доска `PhProfileA`): копия ключей аккаунта на сервере либо файл с этого устройства
  const [isKeysBackupSaved, setIsKeysBackupSaved] = useState<boolean | undefined>();

  useHistoryBack({ isActive, onBack: onReset });

  const sessions = useMemo(() => orderedHashes.map((hash) => byHash[hash]), [byHash, orderedHashes]);
  const otherSessions = sessions.filter((session) => !session.isCurrent);
  const currentSession = sessions.find((session) => session.isCurrent);
  const visibleOffers = linkOffers.filter((offer) => !declinedOffers.includes(getOfferKey(offer)));
  const isUnconfirmed = Boolean(linkStatus?.canRecover);
  const isRotationNeeded = Boolean(sskState?.isRotationNeeded);
  // Ключ подписи меняется корнем: сохранённым на устройстве либо из копии под ключом восстановления
  const canRotateSsk = Boolean(sskState?.hasBackup || sskState?.hasRoot);

  const handleGrantLink = useLastCallback(async (offer: LinkOffer) => {
    const result = await callParvane('parvaneGrantLink', { deviceId: offer.deviceId });
    showNotification({ message: oldLang(result ? 'ParvaneLinkGranted' : 'ParvaneLinkFailed') });
    void refresh();
  });

  const handleCloseTerminateAll = useLastCallback(() => {
    setTerminateAllPassword('');
    setTerminateAllMode('keep');
    closeTerminateAll();
  });

  const handleTerminateAll = useLastCallback(() => {
    if (!terminateAllPassword) return;
    terminateAllAuthorizations({ password: terminateAllPassword, shouldRotateKeys: terminateAllMode === 'rotate' });
    handleCloseTerminateAll();
  });

  const handleDismissLeftDevices = useLastCallback(async () => {
    await callParvane('parvaneDismissLeftDevices', { deviceIds: leftDevices });
    void refresh();
  });

  const handleDecline = useLastCallback(async (offer: LinkOffer) => {
    setDeclinedOffers([...declinedOffers, getOfferKey(offer)]);
    const isDone = await callParvane('parvaneDeclineLink', { deviceId: offer.deviceId });
    showNotification({ message: lang(isDone ? 'ParvaneDeviceDeclined' : 'ParvaneDeviceDeclineFailed') });
    if (!isDone) setDeclinedOffers((current) => current.filter((key) => key !== getOfferKey(offer)));
    void refresh();
  });

  useEffect(() => {
    if (!isActive || !isMobile) return;
    void (callParvane('parvaneKeyBundleContents') as Promise<{ isOff?: boolean } | undefined>).then((contents) => {
      setIsKeysBackupSaved(Boolean(contents && !contents.isOff) || Boolean(getKeysBackupSavedAt(currentUserId)));
    });
  }, [isActive, isMobile, currentUserId]);

  function renderOffer(offer: LinkOffer) {
    const offerName = formatTitle(parseDeviceLabel(offer.label)) || getDeviceLabel(offer.deviceId);
    return (
      <div
        key={offer.deviceId}
        className={styles.offer}
        data-link-offer={offer.deviceId}
        data-link-code={offer.code || ''}
      >
        <div className={styles.offerText}>
          <div className={styles.cardTitle}>
            {isMobile ? lang('ParvaneDeviceOfferTitlePhone') : lang('ParvaneDeviceOfferTitle', { name: offerName })}
          </div>
          <p className={styles.cardText}>
            {isMobile && `${offerName}. `}
            {offer.code ? lang('ParvaneDeviceOfferText') : oldLang('ParvaneLinkOfferWait')}
          </p>
        </div>
        {Boolean(offer.code) && <div className={buildClassName(styles.bigCode, styles.offerCode)}>{offer.code}</div>}
        <div className={styles.offerActions}>
          <button
            type="button"
            className={styles.button}
            data-link-decline
            onClick={() => handleDecline(offer)}
          >
            {lang('ParvaneDeviceDecline')}
          </button>
          <button
            type="button"
            className={buildClassName(styles.button, styles.buttonAccent)}
            disabled={!offer.code}
            data-link-confirm
            onClick={() => handleGrantLink(offer)}
          >
            {lang('ParvaneDeviceConfirm')}
          </button>
        </div>
      </div>
    );
  }

  function formatTitle(title?: DeviceTitle) {
    return title ? `${lang(KIND_KEYS[title.kind])} · ${title.name}` : undefined;
  }

  function formatSeen(atSec: number) {
    return formatSeenAt(atSec * 1000, Date.now(), lang.code, (time) => lang('ParvaneDeviceSeenToday', { time }));
  }

  // Телефон: «Телефон · Android» и «был в сети сегодня, 13:40»; компьютер — одной строкой «Телефон · Android · был
  // сегодня, 13:40 · старая версия», это устройство — «Этот компьютер · Linux · в сети сейчас»
  function describeSession(session: ApiSession) {
    const title = buildDeviceTitle(session.deviceModel, session.platform);
    const isLegacy = session.appVersion === PARVANE_LEGACY_APP_VERSION;
    const seen = formatSeen(session.dateActive);
    if (isMobile) {
      const hint = session.isCurrent ? lang('ParvaneDeviceThis') : lang('ParvaneDeviceSeen', { time: seen });
      const fullHint = isLegacy ? `${hint} · ${lang('ParvaneDeviceOldVersion')}` : hint;
      return { name: formatTitle(title)!, hint: fullHint, seen };
    }
    const name = session.isCurrent
      ? `${lang('ParvaneDeviceThisComputer')} · ${session.platform || title.name}`
      : formatTitle(title)!;
    const parts = [
      name,
      session.isCurrent ? lang('ParvaneDeviceOnlineNow') : lang('ParvaneDeviceSeenShort', { time: seen }),
      isLegacy ? lang('ParvaneDeviceOldVersion') : undefined,
    ];
    return { name: parts.filter(Boolean).join(' · '), hint: undefined, seen };
  }

  const openStolen = useLastCallback((deviceId: string, title: DeviceTitle, seen?: string, hasLeft?: boolean) => {
    setStolenTarget({
      deviceId, title: formatTitle(title)!, kindTitle: lang(KIND_KEYS[title.kind]), seen, hasLeft,
    });
  });

  function renderSession(session: ApiSession) {
    const { isCurrent } = session;
    const { name, hint, seen } = describeSession(session);
    const title = buildDeviceTitle(session.deviceModel, session.platform);
    return (
      <div
        key={session.hash}
        className={styles.deviceRow}
        data-session-row={session.hash}
        data-session-current={isCurrent ? 'true' : undefined}
      >
        <ProfileIcon name={getDeviceIcon(session)} className={styles.deviceIcon} />
        <span className={styles.deviceText}>
          <span className={styles.deviceName} dir="auto">{name}</span>
          {hint && <span className={styles.deviceHint}>{hint}</span>}
        </span>
        {!isCurrent && (
          <button
            type="button"
            className={styles.chip}
            data-session-signout
            onClick={() => setOpenedSessionHash(session.hash)}
          >
            {lang('ParvaneDeviceSignOutOn')}
          </button>
        )}
        {!isCurrent && (
          <button
            type="button"
            className={buildClassName(styles.chip, styles.chipDanger)}
            data-session-stolen={session.hash}
            onClick={() => openStolen(session.hash, title, lang('ParvaneDeviceSeen', { time: seen }))}
          >
            {lang('ParvaneDeviceStolen')}
          </button>
        )}
      </div>
    );
  }

  function renderLeftDevice(deviceId: string) {
    const title: DeviceTitle = { kind: 'computer', name: getDeviceLabel(deviceId) };
    return (
      <div key={deviceId} className={styles.deviceRow} data-left-device-row={deviceId}>
        <ProfileIcon name="globe" className={styles.deviceIcon} />
        <span className={styles.deviceText}>
          <span className={styles.deviceName}>{getDeviceLabel(deviceId)}</span>
          <span className={styles.deviceHint}>{oldLang('ParvaneLeftDeviceSignedOut')}</span>
        </span>
        <button
          type="button"
          className={buildClassName(styles.chip, styles.chipDanger)}
          data-left-device={deviceId}
          onClick={() => openStolen(deviceId, title, oldLang('ParvaneLeftDeviceSignedOut'), true)}
        >
          {lang('ParvaneDeviceStolen')}
        </button>
      </div>
    );
  }

  function renderKeyRow(title: string, hint: string, actions: { label: string; onClick: NoneToVoidFunction }[]) {
    return (
      <div className={buildClassName(profile.setRow, profile.setRowWrap)}>
        <span className={profile.setText}>
          <span className={profile.setTitle}>{title}</span>
          <span className={profile.setHint}>{hint}</span>
        </span>
        {actions.map(({ label, onClick }) => (
          <button key={label} type="button" className={styles.chip} data-device-action onClick={onClick}>
            {label}
          </button>
        ))}
      </div>
    );
  }

  const keysRowClass = buildClassName(profile.setRow, profile.setRowAction);
  const hasSskRow = isRotationNeeded;
  const hasEscrowRow = Boolean(sskState?.isEscrowCopyMissing) && !isRotationNeeded;
  const hasTelegramRow = Boolean(sskState?.canSendKeyToTelegram) && !isRotationNeeded;
  // Компьютер (`DkSettingsA`): служебные строки ключей — только когда нужны, «Копия ключей» — в колонке разделов
  const hasKeysGroup = isMobile || hasSskRow || hasEscrowRow || hasTelegramRow;
  // Телефон (`PhAuth`): «Подтвердите вход» — отдельный экран, без списка устройств и ключей
  const isConfirmOnly = isUnconfirmed && isMobile;

  useLayoutEffect(() => {
    setIsConfirmSignInScreen(Boolean(isActive && isConfirmOnly));
    return () => setIsConfirmSignInScreen(false);
  }, [isActive, isConfirmOnly]);

  return (
    <div className={buildClassName('settings-content custom-scroll SettingsActiveSessions', profile.screen)}>
      {isUnconfirmed && (
        <DeviceConfirmSignIn linkStatus={linkStatus} onRefresh={refresh} onResetIdentity={openReset} />
      )}

      {!isUnconfirmed && linkStatus?.telegram === 'done' && (
        <div className={profile.hint} data-telegram-recovery="done">{oldLang('ParvaneTgRecoverDone')}</div>
      )}

      {visibleOffers.map(renderOffer)}

      {isMobile && !isConfirmOnly && <div className={profile.caption}>{lang('ParvaneDeviceMine')}</div>}
      {!isConfirmOnly && (
        <div className={buildClassName(profile.group, !isMobile && styles.listGap)}>
          {currentSession && renderSession(currentSession)}
          {otherSessions.map(renderSession)}
          {leftDevices.map(renderLeftDevice)}
        </div>
      )}
      {Boolean(leftDevices.length) && !isConfirmOnly && (
        <div className={profile.hint}>
          {oldLang('ParvaneLeftDevicesHint')}
          {' '}
          <button
            type="button"
            className={styles.linkInline}
            data-left-devices-dismiss
            onClick={handleDismissLeftDevices}
          >
            {oldLang('ParvaneLeftDevicesDismiss')}
          </button>
        </div>
      )}

      {!isUnconfirmed && (
        <div className={styles.actions}>
          <button type="button" className={styles.button} data-link-new onClick={openLinkSheet}>
            {lang('ParvaneDeviceLinkNew')}
          </button>
          {Boolean(otherSessions.length) && (
            <button
              type="button"
              className={buildClassName(styles.button, styles.buttonDanger)}
              data-terminate-all
              onClick={openTerminateAll}
            >
              {lang('ParvaneDeviceTerminateOthers')}
            </button>
          )}
        </div>
      )}

      {!isUnconfirmed && (
        <>
          {isMobile && <div className={profile.caption}>{lang('ParvaneDeviceKeys')}</div>}
          {hasKeysGroup && (
            <div className={buildClassName(profile.group, !isMobile && styles.listGap)}>
              {hasSskRow && renderKeyRow(
                oldLang('ParvaneSskRotationTitle'),
                oldLang(canRotateSsk ? 'ParvaneSskRotationText' : 'ParvaneSskRotationNoBackup'),
                [
                  { label: oldLang('ParvaneSskRotationAction'), onClick: () => setKeyDialogMode('rotate') },
                  { label: oldLang('ParvaneResetAction'), onClick: openReset },
                ].filter((_, index) => index > 0 || canRotateSsk),
              )}
              {hasEscrowRow && renderKeyRow(
                oldLang('ParvaneEscrowTitle'),
                oldLang('ParvaneEscrowText'),
                [{ label: oldLang('ParvaneEscrowAction'), onClick: () => setKeyDialogMode('escrow') }],
              )}
              {hasTelegramRow && renderKeyRow(
                oldLang('ParvaneTgSendTitle'),
                oldLang('ParvaneTgSendText'),
                [{ label: oldLang('ParvaneTgSendAction'), onClick: () => setKeyDialogMode('telegram') }],
              )}
              {isMobile && (
                <button
                  type="button"
                  className={keysRowClass}
                  data-device-keys-backup
                  onClick={() => openSettingsScreen({ screen: SettingsScreens.ParvaneKeysBackup })}
                >
                  <span className={profile.setTitle}>{lang('ParvaneProfileKeys')}</span>
                  {isKeysBackupSaved !== undefined && (
                    <span
                      className={profile.setValue}
                      data-device-keys-backup-state={isKeysBackupSaved ? 'saved' : 'none'}
                    >
                      {lang(isKeysBackupSaved ? 'ParvaneDeviceKeysSaved' : 'ParvaneKeysBackupNoneShort')}
                    </span>
                  )}
                  <ProfileIcon name="right" isSmall className={profile.menuChevron} />
                </button>
              )}
            </div>
          )}
          {Boolean(linkStatus?.hasEscrow) && isRotationNeeded && (
            <div className={profile.hint}>{oldLang('ParvaneLostKeyAdmin')}</div>
          )}
          <AccountCards canRotateSsk={canRotateSsk} onRotateSsk={() => setKeyDialogMode('rotate')} />
        </>
      )}

      <PvSheet isOpen={isLinkSheetOpen} title={lang('ParvaneDeviceLinkNew')} onClose={closeLinkSheet}>
        <p className={styles.sheetText}>{lang('ParvaneDeviceLinkNewText')}</p>
      </PvSheet>
      <ConfirmDialog
        isOpen={isTerminateAllOpen}
        onClose={handleCloseTerminateAll}
        text={lang('AreYouSureSessions')}
        confirmLabel={lang('TerminateAllSessions')}
        confirmHandler={handleTerminateAll}
        confirmIsDestructive
        isConfirmDisabled={!terminateAllPassword}
        areButtonsInColumn
      >
        <SessionSignOutMode name="terminate_all_mode" selected={terminateAllMode} onChange={setTerminateAllMode} />
        <SecretForm>
          <input
            type="password"
            className="form-control"
            autoComplete="current-password"
            placeholder={oldLang('ParvanePasswordConfirm')}
            aria-label={oldLang('ParvanePasswordConfirm')}
            value={terminateAllPassword}
            onChange={(e) => setTerminateAllPassword(e.currentTarget.value)}
          />
        </SecretForm>
      </ConfirmDialog>
      <DeviceStolenWizard
        target={stolenTarget}
        hasRoot={sskState?.hasRoot}
        onSignOutOnly={setOpenedSessionHash}
        onClose={() => setStolenTarget(undefined)}
        onDone={refresh}
      />
      <DeviceKeyDialog
        mode={keyDialogMode}
        hasRoot={sskState?.hasRoot}
        onClose={() => setKeyDialogMode(undefined)}
        onDone={refresh}
      />
      <ResetIdentityDialog isOpen={isResetOpen} onClose={closeReset} onDone={refresh} />
      <SettingsActiveSession
        isOpen={Boolean(openedSessionHash)}
        hash={openedSessionHash}
        onClose={() => setOpenedSessionHash(undefined)}
      />
    </div>
  );
};

function getOfferKey(offer: LinkOffer) {
  return `${offer.deviceId}:${offer.code || ''}`;
}

// У устройства в журнале v2 нет имени — только начало идентификатора
function getDeviceLabel(deviceId: string) {
  return deviceId ? `Web ${deviceId.slice(0, DEVICE_ID_PREVIEW)}` : 'Desktop';
}

function getDeviceIcon(session: ApiSession): ProfileIconName {
  return KIND_ICONS[buildDeviceTitle(session.deviceModel, session.platform).kind];
}

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => ({
    byHash: global.activeSessions.byHash,
    orderedHashes: global.activeSessions.orderedHashes,
    currentUserId: global.currentUserId,
  }),
)(SettingsActiveSessions));
