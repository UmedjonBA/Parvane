// Подписи устройств по доскам `PhProfileA`, `DkSettingsA`: «Телефон · Android», «Компьютер · Linux», «Браузер ·
// Firefox»; когда устройство было в сети — «сегодня, 13:40» либо «9 ноября». Устройство называет себя при входе
// строкой «Firefox, Linux» (`describeThisDevice` провайдера); устройства прежних версий себя не называли

export type DeviceKind = 'phone' | 'computer' | 'browser';

export type DeviceTitle = { kind: DeviceKind; name: string };

const PHONE_RE = /android|iphone|ipad|ios/i;
const BROWSERS = new Set(['chrome', 'firefox', 'safari', 'opera', 'edge', 'brave', 'vivaldi', 'samsung']);
const DATE_OPTIONS = { day: 'numeric', month: 'long' } as const;
const TIME_OPTIONS = { hour: '2-digit', minute: '2-digit' } as const;

/** Вид и название устройства по модели и платформе из сеанса (или подписи «модель, платформа»). */
export function buildDeviceTitle(model: string, platform: string): DeviceTitle {
  const isBrowser = BROWSERS.has(model.trim().toLowerCase());
  if (PHONE_RE.test(`${platform} ${model}`)) return { kind: 'phone', name: platform || model };
  if (isBrowser) return { kind: 'browser', name: model };
  return { kind: 'computer', name: platform || model };
}

/** То же по подписи входа «Firefox, Linux»; пустая подпись — `undefined`. */
export function parseDeviceLabel(label?: string): DeviceTitle | undefined {
  if (!label?.trim()) return undefined;
  const [model, platform = ''] = label.split(',').map((part) => part.trim());
  return buildDeviceTitle(model, platform);
}

/** «сегодня, 13:40» либо «9 ноября»: `todayTemplate` получает время. */
export function formatSeenAt(atMs: number, nowMs: number, locale: string, todayTemplate: (time: string) => string) {
  const at = new Date(atMs);
  if (at.toDateString() === new Date(nowMs).toDateString()) {
    return todayTemplate(at.toLocaleTimeString(locale, TIME_OPTIONS));
  }
  return at.toLocaleDateString(locale, DATE_OPTIONS);
}
