import type { ApiSession } from '../../../../api/types';
import type { LangFn } from '../../../../util/localization';

import { PARVANE_LEGACY_APP_VERSION } from '../../../../config';

// Parvane: часть полей пуста (сервер не хранит метаданные устройств) —
// собираем строку только из заполненных, без висячих запятых. Устройство
// вне журнала устройств v2 помечается как «старая версия» (spec 007)
export default function getSessionAppLine(lang: LangFn, session?: ApiSession) {
  if (!session) return '';
  const appVersion = session.appVersion === PARVANE_LEGACY_APP_VERSION
    ? lang('ParvaneDeviceLegacy')
    : session.appVersion;
  return [
    [session.appName, appVersion].filter(Boolean).join(' '),
    [session.platform, session.systemVersion].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
}
