import type { FC } from '../../../lib/teact/teact';
import {
  memo, useCallback, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiSession } from '../../../api/types';
import type { GlobalState } from '../../../global/types';

import { formatPastTimeShort } from '../../../util/dates/oldDateFormat';
import { callApi } from '../../../api/gramjs';
import getSessionAppLine from './helpers/getSessionAppLine';
import getSessionIcon from './helpers/getSessionIcon';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import Island, { IslandTitle } from '../../gili/layout/Island';
import ConfirmDialog from '../../ui/ConfirmDialog';
import ListItem from '../../ui/ListItem';
import RadioGroup from '../../ui/RadioGroup';
import SettingsActiveSession from './SettingsActiveSession';

import './SettingsActiveSessions.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = GlobalState['activeSessions'];

// Parvane: авто-линковка истории — статус собственного оффера и запросы
// других устройств опрашиваются, пока экран открыт
type LinkStatus = { isPending: boolean; code?: string; canRecover?: boolean };
type LinkOffer = { deviceId: string; code?: string };
// Parvane (T128, D-12): отозвано устройство, державшее ключ подписи устройств —
// ключ обновляется корнем из копии под ключом восстановления
type SskState = { isRotationNeeded: boolean; hasBackup: boolean };
type SskRotationResult = 'ok' | 'bad_key' | 'no_backup' | 'failed';
const SSK_RESULT_KEYS: Record<SskRotationResult, string> = {
  ok: 'ParvaneSskRotationDone',
  bad_key: 'ParvaneSskRotationBadKey',
  no_backup: 'ParvaneSskRotationNoBackup',
  failed: 'ParvaneSskRotationFailed',
};
// Parvane (T130): новое устройство без других устройств аккаунта — вход по
// ключу восстановления либо сброс защищённой личности
const RECOVER_RESULT_KEYS: Record<SskRotationResult, string> = {
  ok: 'ParvaneRecoverDone',
  bad_key: 'ParvaneSskRotationBadKey',
  no_backup: 'ParvaneRecoverNoBackup',
  failed: 'ParvaneSskRotationFailed',
};
type ResetResult = 'ok' | 'bad_password' | 'failed';
const RESET_RESULT_KEYS: Record<ResetResult, string> = {
  ok: 'ParvaneResetDone',
  bad_password: 'ParvaneResetBadPassword',
  failed: 'ParvaneResetFailed',
};
const LINK_UI_POLL_MS = 5000;

const SettingsActiveSessions: FC<OwnProps & StateProps> = ({
  isActive,
  onReset,
  byHash,
  orderedHashes,
  ttlDays,
}) => {
  const {
    terminateAllAuthorizations,
    changeSessionTtl,
    showNotification,
  } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();
  const [isConfirmTerminateAllDialogOpen, openConfirmTerminateAllDialog, closeConfirmTerminateAllDialog] = useFlag();
  const [openedSessionHash, setOpenedSessionHash] = useState<string | undefined>();
  const [isModalOpen, openModal, closeModal] = useFlag();

  const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
  const [linkStatus, setLinkStatus] = useState<LinkStatus | undefined>();
  const [linkOffers, setLinkOffers] = useState<LinkOffer[]>([]);
  const [confirmingOffer, setConfirmingOffer] = useState<LinkOffer | undefined>();

  const [sskState, setSskState] = useState<SskState | undefined>();
  const [isSskDialogOpen, openSskDialog, closeSskDialog] = useFlag();
  const [recoveryKey, setRecoveryKey] = useState('');

  const refreshLinkState = useLastCallback(async () => {
    const status = await callParvane('parvaneGetLinkStatus') as LinkStatus | undefined;
    setLinkStatus(status);
    const offers = await callParvane('parvaneListLinkOffers') as { offers: LinkOffer[] } | undefined;
    setLinkOffers(offers?.offers || []);
    setSskState(await callParvane('parvaneGetSskState') as SskState | undefined);
  });

  const handleRecoveryKeyChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRecoveryKey(e.currentTarget.value);
  });

  const handleCloseSskDialog = useLastCallback(() => {
    setRecoveryKey('');
    closeSskDialog();
  });

  // Диалог ключа восстановления общий: обновление ключа подписи (T128) и вход
  // нового устройства по ключу (T130)
  const [isRecoverMode, setIsRecoverMode] = useState(false);
  const [isResetDialogOpen, openResetDialog, closeResetDialog] = useFlag();
  const [resetPassword, setResetPassword] = useState('');

  const handleOpenRecover = useLastCallback(() => {
    setIsRecoverMode(true);
    openSskDialog();
  });

  const handleOpenRotate = useLastCallback(() => {
    setIsRecoverMode(false);
    openSskDialog();
  });

  const handleResetPasswordChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setResetPassword(e.currentTarget.value);
  });

  const handleCloseResetDialog = useLastCallback(() => {
    setResetPassword('');
    closeResetDialog();
  });

  const handleResetIdentity = useLastCallback(async () => {
    const password = resetPassword;
    handleCloseResetDialog();
    if (!password) return;
    const result = await callParvane('parvaneResetIdentity', { password }) as ResetResult | undefined;
    showNotification({ message: oldLang(RESET_RESULT_KEYS[result || 'failed']) });
    void refreshLinkState();
  });

  const handleRotateSsk = useLastCallback(async () => {
    if (isRecoverMode) {
      const key = recoveryKey;
      handleCloseSskDialog();
      if (!key) return;
      const result = await callParvane('parvaneRecoverWithKey', { recoveryKey: key }) as SskRotationResult | undefined;
      showNotification({ message: oldLang(RECOVER_RESULT_KEYS[result || 'failed']) });
      void refreshLinkState();
      return;
    }
    const key = recoveryKey;
    handleCloseSskDialog();
    if (!key) return;
    const result = await callParvane('parvaneRotateSsk', { recoveryKey: key }) as SskRotationResult | undefined;
    showNotification({ message: oldLang(SSK_RESULT_KEYS[result || 'failed']) });
    void refreshLinkState();
  });

  useEffect(() => {
    if (!isActive) return undefined;
    void refreshLinkState();
    const timer = window.setInterval(() => {
      void refreshLinkState();
    }, LINK_UI_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isActive, refreshLinkState]);

  const handleGrantLink = useLastCallback(async () => {
    const offer = confirmingOffer;
    setConfirmingOffer(undefined);
    if (!offer) return;
    const result = await callParvane('parvaneGrantLink', { deviceId: offer.deviceId });
    showNotification({
      message: oldLang(result ? 'ParvaneLinkGranted' : 'ParvaneLinkFailed'),
    });
    void refreshLinkState();
  });

  const autoTerminateValue = useMemo(() => {
    // https://github.com/DrKLO/Telegram/blob/96dce2c9aabc33b87db61d830aa087b6b03fe397/TMessagesProj/src/main/java/org/telegram/ui/SessionsActivity.java#L195
    if (ttlDays === undefined) {
      return undefined;
    }

    if (ttlDays <= 7) {
      return '7';
    }

    if (ttlDays <= 30) {
      return '30';
    }

    if (ttlDays <= 93) {
      return '90';
    }

    if (ttlDays <= 183) {
      return '183';
    }

    if (ttlDays > 183) {
      return '365';
    }

    return undefined;
  }, [ttlDays]);

  const AUTO_TERMINATE_OPTIONS = useMemo(() => {
    const options = [{
      label: lang('Weeks', { count: 1 }, { pluralValue: 1 }),
      value: '7',
    }, {
      label: lang('Months', { count: 1 }, { pluralValue: 1 }),
      value: '30',
    }, {
      label: lang('Months', { count: 3 }, { pluralValue: 3 }),
      value: '90',
    }, {
      label: lang('Months', { count: 6 }, { pluralValue: 6 }),
      value: '183',
    }];
    if (ttlDays && ttlDays >= 365) {
      options.push({
        label: lang('Years', { count: 1 }, { pluralValue: 1 }),
        value: '365',
      });
    }
    return options;
  }, [lang, ttlDays]);

  // Parvane (P-07): отзыв устройства требует текущий пароль — «завершить все»
  // спрашивает его в диалоге подтверждения, отзыв одного — в модалке сеанса
  const [terminateAllPassword, setTerminateAllPassword] = useState('');

  const handleTerminateAllPasswordChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTerminateAllPassword(e.currentTarget.value);
  }, []);

  const handleCloseTerminateAllDialog = useCallback(() => {
    setTerminateAllPassword('');
    closeConfirmTerminateAllDialog();
  }, [closeConfirmTerminateAllDialog]);

  const handleTerminateAllSessions = useCallback(() => {
    if (!terminateAllPassword) return;
    terminateAllAuthorizations({ password: terminateAllPassword });
    handleCloseTerminateAllDialog();
  }, [handleCloseTerminateAllDialog, terminateAllAuthorizations, terminateAllPassword]);

  const handleOpenSessionModal = useCallback((hash: string) => {
    setOpenedSessionHash(hash);
    openModal();
  }, [openModal]);

  const handleCloseSessionModal = useCallback(() => {
    setOpenedSessionHash(undefined);
    closeModal();
  }, [closeModal]);

  const handleChangeSessionTtl = useCallback((value: string) => {
    changeSessionTtl({ days: Number(value) });
  }, [changeSessionTtl]);

  const currentSession = useMemo(() => {
    const currentSessionHash = orderedHashes.find((hash) => byHash[hash].isCurrent);

    return currentSessionHash ? byHash[currentSessionHash] : undefined;
  }, [byHash, orderedHashes]);

  const otherSessionHashes = useMemo(() => {
    return orderedHashes.filter((hash) => !byHash[hash].isCurrent);
  }, [byHash, orderedHashes]);
  const hasOtherSessions = Boolean(otherSessionHashes.length);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  function renderCurrentSession(session: ApiSession) {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('AuthSessionsCurrentSession')}
        </IslandTitle>
        <Island>
          <ListItem narrow inactive icon={`device-${getSessionIcon(session)}`} iconClassName="icon-device">
            <div className="multiline-item full-size" dir="auto">
              <span className="title" dir="auto">{session.deviceModel}</span>
              <span className="subtitle black tight">{getSessionAppLine(lang, session)}</span>
              {Boolean(session.ip || getLocation(session)) && (
                <span className="subtitle">
                  {[session.ip, getLocation(session)].filter(Boolean).join(' - ')}
                </span>
              )}
            </div>
          </ListItem>

          {hasOtherSessions && (
            <ListItem
              className="destructive mb-0 no-icon"
              icon="stop"
              ripple
              narrow
              onClick={openConfirmTerminateAllDialog}
            >
              {lang('TerminateAllSessions')}
            </ListItem>
          )}
        </Island>
      </>
    );
  }

  function renderOtherSessions(sessionHashes: string[]) {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('OtherSessions')}
        </IslandTitle>
        <Island>
          {sessionHashes.map(renderSession)}
        </Island>
      </>
    );
  }

  function renderAutoTerminate() {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('TerminateOldSessionHeader')}
        </IslandTitle>
        <Island>
          <p className="settings-item-description-larger">{lang('IfInactiveFor')}</p>
          <RadioGroup
            name="session_ttl"
            options={AUTO_TERMINATE_OPTIONS}
            selected={autoTerminateValue}
            onChange={handleChangeSessionTtl}
          />
        </Island>
      </>
    );
  }

  // Parvane: новое устройство ждёт передачу истории — показываем код сверки
  function renderLinkPending(code?: string) {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {oldLang('ParvaneLinkPendingTitle')}
        </IslandTitle>
        <Island>
          <p className="settings-item-description-larger">
            {code ? oldLang('ParvaneLinkPendingText', code) : oldLang('ParvaneLinkPendingWait')}
          </p>
        </Island>
      </>
    );
  }

  // Parvane: других устройств не осталось — ключ восстановления или сброс
  function renderRecover() {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {oldLang('ParvaneRecoverTitle')}
        </IslandTitle>
        <Island>
          <p className="settings-item-description-larger">
            {oldLang('ParvaneRecoverText')}
          </p>
          <ListItem icon="key" narrow ripple onClick={handleOpenRecover}>
            {oldLang('ParvaneRecoverAction')}
          </ListItem>
          <ListItem icon="delete" narrow ripple destructive onClick={openResetDialog}>
            {oldLang('ParvaneResetAction')}
          </ListItem>
        </Island>
      </>
    );
  }

  // Parvane: ключ подписи устройств ждёт обновления после отзыва устройства
  function renderSskRotation(hasBackup: boolean) {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {oldLang('ParvaneSskRotationTitle')}
        </IslandTitle>
        <Island>
          <p className="settings-item-description-larger">
            {oldLang(hasBackup ? 'ParvaneSskRotationText' : 'ParvaneSskRotationNoBackup')}
          </p>
          {hasBackup && (
            <ListItem icon="key" narrow ripple onClick={handleOpenRotate}>
              {oldLang('ParvaneSskRotationAction')}
            </ListItem>
          )}
        </Island>
      </>
    );
  }

  // Parvane: запросы истории от других устройств аккаунта
  function renderLinkOffers() {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {oldLang('ParvaneLinkRequests')}
        </IslandTitle>
        <Island>
          {linkOffers.map((offer) => (
            <ListItem
              key={offer.deviceId}
              icon="key"
              narrow
              ripple
              disabled={!offer.code}
              onClick={() => setConfirmingOffer(offer)}
            >
              <div className="multiline-item full-size" dir="auto">
                <span className="title">
                  {offer.deviceId ? `Web ${offer.deviceId.slice(0, 8)}` : 'Desktop'}
                </span>
                <span className="subtitle">
                  {offer.code ? oldLang('ParvaneLinkOfferCode', offer.code) : oldLang('ParvaneLinkOfferWait')}
                </span>
              </div>
            </ListItem>
          ))}
        </Island>
      </>
    );
  }

  function renderSession(sessionHash: string) {
    const session = byHash[sessionHash];

    return (
      <ListItem
        key={session.hash}
        ripple
        narrow
        contextActions={[{
          title: lang('SessionTerminate'),
          icon: 'stop',
          destructive: true,
          handler: () => {
            handleOpenSessionModal(session.hash);
          },
        }]}
        icon={`device-${getSessionIcon(session)}`}
        iconClassName="icon-device"
        onClick={() => { handleOpenSessionModal(session.hash); }}
      >
        <div className="multiline-item full-size" dir="auto">
          <span className="title title-with-date">
            {session.deviceModel}
            <span className="date">{formatPastTimeShort(oldLang, session.dateActive * 1000)}</span>
          </span>
          <span className="subtitle black tight">{getSessionAppLine(lang, session)}</span>
          {Boolean(session.ip || getLocation(session)) && (
            <span className="subtitle">
              {[session.ip, getLocation(session)].filter(Boolean).join(' ')}
            </span>
          )}
        </div>
      </ListItem>
    );
  }

  return (
    <div className="settings-content custom-scroll SettingsActiveSessions">
      {currentSession && renderCurrentSession(currentSession)}
      {Boolean(linkStatus?.isPending) && renderLinkPending(linkStatus.code)}
      {Boolean(linkStatus?.canRecover) && renderRecover()}
      {Boolean(linkOffers.length) && renderLinkOffers()}
      {Boolean(sskState?.isRotationNeeded) && renderSskRotation(Boolean(sskState?.hasBackup))}
      {hasOtherSessions && renderOtherSessions(otherSessionHashes)}
      {/* Parvane: авто-терминация по TTL не поддерживается сервером — секция
          показывается только когда бэкенд отдал ttlDays */}
      {ttlDays !== undefined && renderAutoTerminate()}
      {hasOtherSessions && (
        <ConfirmDialog
          isOpen={isConfirmTerminateAllDialogOpen}
          onClose={handleCloseTerminateAllDialog}
          text={lang('AreYouSureSessions')}
          confirmLabel={lang('TerminateAllSessions')}
          confirmHandler={handleTerminateAllSessions}
          confirmIsDestructive
          isConfirmDisabled={!terminateAllPassword}
          areButtonsInColumn
        >
          <input
            type="password"
            className="form-control"
            autoComplete="current-password"
            placeholder={oldLang('ParvanePasswordConfirm')}
            aria-label={oldLang('ParvanePasswordConfirm')}
            value={terminateAllPassword}
            onChange={handleTerminateAllPasswordChange}
          />
        </ConfirmDialog>
      )}
      <ConfirmDialog
        isOpen={Boolean(confirmingOffer)}
        onClose={() => setConfirmingOffer(undefined)}
        text={confirmingOffer?.code ? oldLang('ParvaneLinkConfirm', confirmingOffer.code) : ''}
        confirmLabel={oldLang('ParvaneLinkConfirmAction')}
        confirmHandler={handleGrantLink}
      />
      <ConfirmDialog
        isOpen={isSskDialogOpen}
        onClose={handleCloseSskDialog}
        text={oldLang(isRecoverMode ? 'ParvaneRecoverText' : 'ParvaneSskRotationText')}
        confirmLabel={oldLang(isRecoverMode ? 'ParvaneRecoverAction' : 'ParvaneSskRotationAction')}
        confirmHandler={handleRotateSsk}
        isConfirmDisabled={!recoveryKey}
        areButtonsInColumn
      >
        <input
          type="text"
          className="form-control"
          autoComplete="off"
          spellCheck={false}
          placeholder={oldLang('ParvaneSskRotationPlaceholder')}
          aria-label={oldLang('ParvaneSskRotationPlaceholder')}
          value={recoveryKey}
          onChange={handleRecoveryKeyChange}
        />
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={isResetDialogOpen}
        onClose={handleCloseResetDialog}
        text={oldLang('ParvaneResetText')}
        confirmLabel={oldLang('ParvaneResetConfirm')}
        confirmHandler={handleResetIdentity}
        confirmIsDestructive
        isConfirmDisabled={!resetPassword}
        areButtonsInColumn
      >
        <input
          type="password"
          className="form-control"
          autoComplete="current-password"
          placeholder={oldLang('ParvanePasswordConfirm')}
          aria-label={oldLang('ParvanePasswordConfirm')}
          value={resetPassword}
          onChange={handleResetPasswordChange}
        />
      </ConfirmDialog>
      <SettingsActiveSession isOpen={isModalOpen} hash={openedSessionHash} onClose={handleCloseSessionModal} />
    </div>
  );
};

function getLocation(session: ApiSession) {
  return [session.region, session.country].filter(Boolean).join(', ');
}

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => global.activeSessions as Complete<StateProps>,
)(SettingsActiveSessions));
