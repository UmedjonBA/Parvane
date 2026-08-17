import type { FC } from '../../../lib/teact/teact';
import {
  memo, useCallback, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiSession } from '../../../api/types';
import type { GlobalState } from '../../../global/types';

import { formatPastTimeShort } from '../../../util/dates/oldDateFormat';
import { callApi } from '../../../api/gramjs';
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
type LinkStatus = { isPending: boolean; code?: string };
type LinkOffer = { deviceId: string; code: string };
const LINK_UI_POLL_MS = 5000;

const SettingsActiveSessions: FC<OwnProps & StateProps> = ({
  isActive,
  onReset,
  byHash,
  orderedHashes,
  ttlDays,
}) => {
  const {
    terminateAuthorization,
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

  const refreshLinkState = useLastCallback(async () => {
    const status = await callParvane('parvaneGetLinkStatus') as LinkStatus | undefined;
    setLinkStatus(status);
    const offers = await callParvane('parvaneListLinkOffers') as { offers: LinkOffer[] } | undefined;
    setLinkOffers(offers?.offers || []);
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

  const handleTerminateSessionClick = useCallback((hash: string) => {
    terminateAuthorization({ hash });
  }, [terminateAuthorization]);

  const handleTerminateAllSessions = useCallback(() => {
    closeConfirmTerminateAllDialog();
    terminateAllAuthorizations();
  }, [closeConfirmTerminateAllDialog, terminateAllAuthorizations]);

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
              <span className="subtitle black tight">{getAppLine(session)}</span>
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
  function renderLinkPending(code: string) {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {oldLang('ParvaneLinkPendingTitle')}
        </IslandTitle>
        <Island>
          <p className="settings-item-description-larger">
            {oldLang('ParvaneLinkPendingText', code)}
          </p>
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
              onClick={() => setConfirmingOffer(offer)}
            >
              <div className="multiline-item full-size" dir="auto">
                <span className="title">
                  {offer.deviceId ? `Web ${offer.deviceId.slice(0, 8)}` : 'Desktop'}
                </span>
                <span className="subtitle">{oldLang('ParvaneLinkOfferCode', offer.code)}</span>
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
            handleTerminateSessionClick(session.hash);
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
          <span className="subtitle black tight">{getAppLine(session)}</span>
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
      {Boolean(linkStatus?.isPending && linkStatus.code) && renderLinkPending(linkStatus!.code!)}
      {Boolean(linkOffers.length) && renderLinkOffers()}
      {hasOtherSessions && renderOtherSessions(otherSessionHashes)}
      {/* Parvane: авто-терминация по TTL не поддерживается сервером — секция
          показывается только когда бэкенд отдал ttlDays */}
      {ttlDays !== undefined && renderAutoTerminate()}
      {hasOtherSessions && (
        <ConfirmDialog
          isOpen={isConfirmTerminateAllDialogOpen}
          onClose={closeConfirmTerminateAllDialog}
          text={lang('AreYouSureSessions')}
          confirmLabel={lang('TerminateAllSessions')}
          confirmHandler={handleTerminateAllSessions}
          confirmIsDestructive
          areButtonsInColumn
        />
      )}
      <ConfirmDialog
        isOpen={Boolean(confirmingOffer)}
        onClose={() => setConfirmingOffer(undefined)}
        text={confirmingOffer ? oldLang('ParvaneLinkConfirm', confirmingOffer.code) : ''}
        confirmLabel={oldLang('ParvaneLinkConfirmAction')}
        confirmHandler={handleGrantLink}
      />
      <SettingsActiveSession isOpen={isModalOpen} hash={openedSessionHash} onClose={handleCloseSessionModal} />
    </div>
  );
};

function getLocation(session: ApiSession) {
  return [session.region, session.country].filter(Boolean).join(', ');
}

// Parvane: часть полей пуста (сервер не хранит метаданные устройств) —
// собираем строку только из заполненных, без висячих запятых
function getAppLine(session: ApiSession) {
  return [
    [session.appName, session.appVersion].filter(Boolean).join(' '),
    [session.platform, session.systemVersion].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
}

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => global.activeSessions as Complete<StateProps>,
)(SettingsActiveSessions));
