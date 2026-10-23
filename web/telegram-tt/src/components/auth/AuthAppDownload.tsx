import { memo } from '../../lib/teact/teact';

import useLang from '../../hooks/useLang';

import Icon from '../common/icons/Icon';

// Parvane: кнопка страницы скачивания Android-приложения под формами входа и регистрации.
// Ведёт на `/download` (вход сборки `download.html`): там описание, размер, QR-код и установка,
// а не сразу файл APK
const AuthAppDownload = () => {
  const lang = useLang();

  return (
    <div className="auth-app-download">
      <div className="auth-app-download-divider">{lang('ParvaneAppDownloadOr')}</div>
      <a id="auth-app-download" className="auth-app-download-button" href="./download">
        <span className="auth-app-download-icon">
          <Icon name="download" />
        </span>
        <span className="auth-app-download-text">
          <span className="auth-app-download-title">{lang('ParvaneAppDownload')}</span>
          <span className="auth-app-download-subtitle">{lang('ParvaneAppDownloadHint')}</span>
        </span>
      </a>
    </div>
  );
};

export default memo(AuthAppDownload);
