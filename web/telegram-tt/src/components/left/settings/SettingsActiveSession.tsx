import type { FC } from '../../../lib/teact/teact';
import { memo, useCallback, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiSession } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { formatDateTimeToString } from '../../../util/dates/oldDateFormat';
import getSessionAppLine from './helpers/getSessionAppLine';
import getSessionIcon from './helpers/getSessionIcon';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';

import styles from './SettingsActiveSession.module.scss';

type OwnProps = {
  isOpen: boolean;
  hash?: string;
  onClose: () => void;
};

type StateProps = {
  session?: ApiSession;
};

const SettingsActiveSession: FC<OwnProps & StateProps> = ({
  isOpen, session, onClose,
}) => {
  const { terminateAuthorization } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();

  const renderingSession = useCurrentOrPrev(session, true);

  // Parvane (P-07): сервер отзывает устройство только с текущим паролем
  const [password, setPassword] = useState('');

  const handlePasswordChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.currentTarget.value);
  }, []);

  const handleClose = useCallback(() => {
    setPassword('');
    onClose();
  }, [onClose]);

  const handleTerminateSessionClick = useCallback(() => {
    if (!password) return;
    terminateAuthorization({ hash: session!.hash, password });
    handleClose();
  }, [handleClose, password, session, terminateAuthorization]);

  if (!renderingSession) {
    return undefined;
  }

  function renderHeader() {
    return (
      <div className="modal-header-condensed" dir={lang.isRtl ? 'rtl' : undefined}>
        <Button
          round
          color="translucent"
          size="tiny"
          ariaLabel={lang('Close')}
          onClick={handleClose}
          iconName="close"
        />
        <div className="modal-title">{lang('SessionPreviewTitle')}</div>
      </div>
    );
  }

  return (
    <Modal
      header={renderHeader()}
      isOpen={isOpen}
      hasCloseButton
      onClose={handleClose}
      className={styles.SettingsActiveSession}
    >
      <div className={buildClassName(
        styles.iconDevice,
        renderingSession && styles[`iconDevice__${getSessionIcon(renderingSession)}`],
      )}
      />
      <h3 className={styles.title} dir="auto">{renderingSession?.deviceModel}</h3>
      <div className={styles.date} aria-label={lang('PrivacySettingsLastSeen')}>
        {formatDateTimeToString(renderingSession.dateActive * 1000, lang.code)}
      </div>

      <dl className={styles.box}>
        <dt>{lang('SessionPreviewApp')}</dt>
        <dd>{getSessionAppLine(lang, renderingSession)}</dd>
        {renderingSession?.ip && (
          <>
            <dt>{lang('SessionPreviewIp')}</dt>
            <dd>{renderingSession.ip}</dd>
          </>
        )}

        {Boolean(getLocation(renderingSession)) && (
          <>
            <dt>{lang('SessionPreviewLocation')}</dt>
            <dd>{getLocation(renderingSession)}</dd>
          </>
        )}
      </dl>

      {/* Parvane: IP/гео сервер не хранит, per-session тумблеры звонков и
          секретных чатов не поддерживаются — примечание и переключатели скрыты */}
      <p className={buildClassName(styles.note, 'mb-2')}>{oldLang('ParvaneSessionPasswordHint')}</p>
      <input
        type="password"
        className="form-control"
        autoComplete="current-password"
        placeholder={oldLang('ParvanePasswordConfirm')}
        aria-label={oldLang('ParvanePasswordConfirm')}
        value={password}
        onChange={handlePasswordChange}
      />
      <div className="dialog-buttons mt-2">
        <Button
          color="danger"
          className="confirm-dialog-button"
          isText
          disabled={!password}
          onClick={handleTerminateSessionClick}
        >
          {lang('SessionPreviewTerminateSession')}
        </Button>
      </div>
    </Modal>
  );
};

function getLocation(session: ApiSession) {
  return [session.region, session.country].filter(Boolean).join(', ');
}

export default memo(withGlobal<OwnProps>((global, { hash }) => {
  return {
    session: hash ? global.activeSessions.byHash[hash] : undefined,
  };
})(SettingsActiveSession));
