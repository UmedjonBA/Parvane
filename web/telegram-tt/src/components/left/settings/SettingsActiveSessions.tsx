import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiSession } from '../../../api/types';
import type { GlobalState } from '../../../global/types';
import type { KeyDialogMode } from './devices/DeviceDialogs';
import type { LinkOffer } from './devices/useDeviceLink';
import type { ProfileIconName } from './profile/ProfileIcon';
import { SettingsScreens } from '../../../types';

import buildClassName from '../../../util/buildClassName';
import { formatPastTimeShort } from '../../../util/dates/oldDateFormat';
import { callApi } from '../../../api/gramjs';
import useDeviceLink from './devices/useDeviceLink';
import getSessionAppLine from './helpers/getSessionAppLine';
import getSessionIcon from './helpers/getSessionIcon';

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
import ProfileIcon from './profile/ProfileIcon';
import SessionSignOutMode, { type SignOutMode } from './SessionSignOutMode';
import SettingsActiveSession from './SettingsActiveSession';

import styles from './devices/Devices.module.scss';
import profile from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = Pick<GlobalState['activeSessions'], 'byHash' | 'orderedHashes'>;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const PHONE_ICONS = new Set(['android', 'apple']);
const BROWSER_ICONS = new Set(['chrome', 'brave', 'vivaldi', 'safari', 'firefox', 'opera', 'samsung']);
const DEVICE_ID_PREVIEW = 8;

// Parvane (spec 041 E3): «Профиль → Устройства» по доскам `PhProfileA`, `DkSettingsA`: запрос нового своего
// устройства карточкой с кодом сверки, «Мои устройства» с «Выйти на нём» и «Украдено», «Привязать новое
// устройство», «Завершить другие сеансы», ключи. Это устройство ещё не подтверждено — сверху «Подтвердите вход»
// (`devices/DeviceConfirmSignIn.tsx`). Действия прежние: провайдер (LINK-1, RECOVER-1/2, REVOKE-1, P-07 — отзыв
// устройства только с текущим паролем)
const SettingsActiveSessions = ({
  isActive,
  onReset,
  byHash,
  orderedHashes,
}: OwnProps & StateProps) => {
  const { terminateAllAuthorizations, showNotification, openSettingsScreen } = getActions();

  const lang = useLang();
  const oldLang = useOldLang();
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
  const [stolenDevice, setStolenDevice] = useState<string | undefined>();
  // «Отклонить» запрос: сервер отказа не принимает, запрос просто скрывается здесь до истечения
  const [declinedOffers, setDeclinedOffers] = useState<string[]>([]);

  useHistoryBack({ isActive, onBack: onReset });

  const sessions = useMemo(() => orderedHashes.map((hash) => byHash[hash]), [byHash, orderedHashes]);
  const otherSessions = sessions.filter((session) => !session.isCurrent);
  const currentSession = sessions.find((session) => session.isCurrent);
  const visibleOffers = linkOffers.filter((offer) => !declinedOffers.includes(getOfferKey(offer)));
  const isUnconfirmed = Boolean(linkStatus?.canRecover);
  const isRotationNeeded = Boolean(sskState?.isRotationNeeded);

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

  const handleReportStolen = useLastCallback(async () => {
    const deviceId = stolenDevice;
    setStolenDevice(undefined);
    if (!deviceId) return;
    const isDone = await callParvane('parvaneReportDeviceStolen', { deviceId });
    showNotification({
      message: oldLang(isDone ? 'ParvaneLeftDeviceStolenDone' : 'ParvaneLeftDeviceStolenFailed'),
    });
    void refresh();
  });

  function renderOffer(offer: LinkOffer) {
    return (
      <div
        key={offer.deviceId}
        className={styles.offer}
        data-link-offer={offer.deviceId}
        data-link-code={offer.code || ''}
      >
        <div className={styles.offerText}>
          <div className={styles.cardTitle}>
            {lang('ParvaneDeviceOfferTitle', { name: getDeviceLabel(offer.deviceId) })}
          </div>
          <p className={styles.cardText}>
            {offer.code ? lang('ParvaneDeviceOfferText') : oldLang('ParvaneLinkOfferWait')}
          </p>
        </div>
        {Boolean(offer.code) && <div className={buildClassName(styles.bigCode, styles.offerCode)}>{offer.code}</div>}
        <div className={styles.offerActions}>
          <button
            type="button"
            className={styles.button}
            data-link-decline
            onClick={() => setDeclinedOffers([...declinedOffers, getOfferKey(offer)])}
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

  function renderSession(session: ApiSession) {
    const { isCurrent } = session;
    const appLine = getSessionAppLine(lang, session);
    const hint = isCurrent
      ? lang('ParvaneDeviceThis')
      : [appLine, lang('ParvaneDeviceSeen', { time: formatPastTimeShort(oldLang, session.dateActive * 1000) })]
        .filter(Boolean).join(' · ');
    return (
      <div
        key={session.hash}
        className={styles.deviceRow}
        data-session-row={session.hash}
        data-session-current={isCurrent ? 'true' : undefined}
      >
        <ProfileIcon name={getDeviceIcon(session)} className={styles.deviceIcon} />
        <span className={styles.deviceText}>
          <span className={styles.deviceName} dir="auto">{session.deviceModel}</span>
          <span className={styles.deviceHint}>{hint}</span>
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
      </div>
    );
  }

  function renderLeftDevice(deviceId: string) {
    return (
      <div key={deviceId} className={styles.deviceRow}>
        <ProfileIcon name="globe" className={styles.deviceIcon} />
        <span className={styles.deviceText}>
          <span className={styles.deviceName}>{getDeviceLabel(deviceId)}</span>
          <span className={styles.deviceHint}>{oldLang('ParvaneLeftDeviceSignedOut')}</span>
        </span>
        <button
          type="button"
          className={buildClassName(styles.chip, styles.chipDanger)}
          data-left-device={deviceId}
          onClick={() => setStolenDevice(deviceId)}
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

  return (
    <div className={buildClassName('settings-content custom-scroll SettingsActiveSessions', profile.screen)}>
      {isUnconfirmed && (
        <DeviceConfirmSignIn linkStatus={linkStatus} onRefresh={refresh} onResetIdentity={openReset} />
      )}

      {!isUnconfirmed && linkStatus?.telegram === 'done' && (
        <div className={profile.hint} data-telegram-recovery="done">{oldLang('ParvaneTgRecoverDone')}</div>
      )}

      {visibleOffers.map(renderOffer)}

      <div className={profile.caption}>{lang('ParvaneDeviceMine')}</div>
      <div className={profile.group}>
        {currentSession && renderSession(currentSession)}
        {otherSessions.map(renderSession)}
        {leftDevices.map(renderLeftDevice)}
      </div>
      {Boolean(leftDevices.length) && (
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
              {lang('TerminateAllSessions')}
            </button>
          )}
        </div>
      )}

      {!isUnconfirmed && (
        <>
          <div className={profile.caption}>{lang('ParvaneDeviceKeys')}</div>
          <div className={profile.group}>
            {isRotationNeeded && renderKeyRow(
              oldLang('ParvaneSskRotationTitle'),
              oldLang(sskState.hasBackup ? 'ParvaneSskRotationText' : 'ParvaneSskRotationNoBackup'),
              [
                { label: oldLang('ParvaneSskRotationAction'), onClick: () => setKeyDialogMode('rotate') },
                { label: oldLang('ParvaneResetAction'), onClick: openReset },
              ].filter((_, index) => index > 0 || sskState.hasBackup),
            )}
            {Boolean(sskState?.isEscrowCopyMissing) && !isRotationNeeded && renderKeyRow(
              oldLang('ParvaneEscrowTitle'),
              oldLang('ParvaneEscrowText'),
              [{ label: oldLang('ParvaneEscrowAction'), onClick: () => setKeyDialogMode('escrow') }],
            )}
            {Boolean(sskState?.canSendKeyToTelegram) && !isRotationNeeded && renderKeyRow(
              oldLang('ParvaneTgSendTitle'),
              oldLang('ParvaneTgSendText'),
              [{ label: oldLang('ParvaneTgSendAction'), onClick: () => setKeyDialogMode('telegram') }],
            )}
            <button
              type="button"
              className={keysRowClass}
              data-device-keys-backup
              onClick={() => openSettingsScreen({ screen: SettingsScreens.ParvaneKeysBackup })}
            >
              <span className={profile.setTitle}>{lang('ParvaneProfileKeys')}</span>
              <ProfileIcon name="right" isSmall className={profile.menuChevron} />
            </button>
          </div>
          {Boolean(linkStatus?.hasEscrow) && isRotationNeeded && (
            <div className={profile.hint}>{oldLang('ParvaneLostKeyAdmin')}</div>
          )}
          <AccountCards canRotateSsk={Boolean(sskState?.hasBackup)} onRotateSsk={() => setKeyDialogMode('rotate')} />
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
      <ConfirmDialog
        isOpen={Boolean(stolenDevice)}
        onClose={() => setStolenDevice(undefined)}
        text={stolenDevice ? oldLang('ParvaneLeftDeviceStolenConfirm', getDeviceLabel(stolenDevice)) : ''}
        confirmLabel={oldLang('ParvaneLeftDeviceStolen')}
        confirmHandler={handleReportStolen}
        confirmIsDestructive
      />
      <DeviceKeyDialog mode={keyDialogMode} onClose={() => setKeyDialogMode(undefined)} onDone={refresh} />
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
  const icon = getSessionIcon(session);
  if (PHONE_ICONS.has(icon) && /android|iphone|ipad|ios/i.test(`${session.platform} ${session.deviceModel}`)) {
    return 'phone';
  }
  return BROWSER_ICONS.has(icon) ? 'globe' : 'laptop';
}

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => ({
    byHash: global.activeSessions.byHash,
    orderedHashes: global.activeSessions.orderedHashes,
  }),
)(SettingsActiveSessions));
