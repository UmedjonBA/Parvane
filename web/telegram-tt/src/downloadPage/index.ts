import '../assets/fonts/parvane.css';
import './style.css';

import logoUrl from '../assets/telegram-logo.svg';

// Parvane: страница скачивания Android-приложения (`/download`, вход сборки `download.html`). Без приложения,
// движка и service worker: размер и дату файла берёт запросом `HEAD` к самому APK, на компьютере рисует QR-код
// адреса страницы — открыть её на телефоне

type Lang = 'ru' | 'en';
type Platform = 'android' | 'ios' | 'desktop';

const APK_URL = '/apk/parvane-android-arm64.apk';
const QR_SIZE = 200;
const MEGABYTE = 1024 * 1024;

const STRINGS = {
  ru: {
    docTitle: 'Parvane для Android',
    title: 'Parvane для Android',
    lead: 'Мессенджер со сквозным шифрованием, «План», «Здоровье», «Знания» и «Облако» — в телефоне.',
    download: 'Скачать APK',
    requirements: 'Android 7.0 и новее · 64-битный телефон (arm64)',
    iosNotice: 'Приложения для iPhone пока нет. Откройте веб-версию в Safari и добавьте её на экран «Домой»: '
      + '«Поделиться» → «На экран „Домой“».',
    qrTitle: 'Скачать на телефон',
    qrHint: 'Наведите камеру телефона на код — откроется эта страница, оттуда скачайте APK.',
    stepsTitle: 'Как установить',
    steps: [
      'Нажмите «Скачать APK» и дождитесь конца загрузки.',
      'Откройте скачанный файл из уведомления или из «Загрузок».',
      'Если Android спросит, разрешите установку приложений из этого источника (браузера или «Файлов»).',
      'Нажмите «Установить» и откройте Parvane.',
      'Обновление — так же: установите новый APK поверх, переписка и настройки сохранятся.',
    ],
    warning: 'Приложения нет в Google Play, поэтому Play Защита может предупредить о неизвестном разработчике — '
      + 'это ожидаемо. Скачивайте APK только с этой страницы.',
    features: [
      ['Шифрование', 'Сообщения, группы и звонки шифруются на устройствах — сервер видит только шифртекст.'],
      ['Без Google', 'Уведомления через UnifiedPush либо фоновую проверку — без Firebase и сервисов Google.'],
      ['Всё в одном', 'Чаты, план дня, заметки с графом и холстом, файлы — то же, что в веб-версии.'],
    ],
    web: 'Открыть веб-версию',
    meta: (size: string, date: string) => `${size} · обновлено ${date}`,
    megabytes: 'МБ',
  },
  en: {
    docTitle: 'Parvane for Android',
    title: 'Parvane for Android',
    lead: 'End-to-end encrypted messenger with Plan, Health, Knowledge and Cloud — on your phone.',
    download: 'Download APK',
    requirements: 'Android 7.0 or newer · 64-bit phone (arm64)',
    iosNotice: 'There is no iPhone app yet. Open the web version in Safari and add it to the Home Screen: '
      + 'Share → Add to Home Screen.',
    qrTitle: 'Get it on your phone',
    qrHint: 'Point your phone camera at the code to open this page there, then download the APK.',
    stepsTitle: 'How to install',
    steps: [
      'Tap “Download APK” and wait for the download to finish.',
      'Open the downloaded file from the notification or from Downloads.',
      'If Android asks, allow installing apps from this source (your browser or Files).',
      'Tap “Install” and open Parvane.',
      'To update, install the new APK the same way — chats and settings are kept.',
    ],
    warning: 'The app is not on Google Play, so Play Protect may warn about an unknown developer — '
      + 'that is expected. Only download the APK from this page.',
    features: [
      ['Encrypted', 'Messages, groups and calls are encrypted on your devices — the server only sees ciphertext.'],
      ['No Google', 'Notifications via UnifiedPush or background checks — no Firebase, no Google services.'],
      ['All in one', 'Chats, day plan, notes with graph and canvas, files — the same as the web version.'],
    ],
    web: 'Open the web version',
    meta: (size: string, date: string) => `${size} · updated ${date}`,
    megabytes: 'MB',
  },
};

const lang: Lang = /^ru\b/i.test(navigator.language) ? 'ru' : 'en';
const strings = STRINGS[lang];

render();

function render() {
  document.documentElement.lang = lang;
  document.title = strings.docTitle;

  const logo = document.querySelector<HTMLImageElement>('.logo')!;
  logo.src = logoUrl;

  setText('title', strings.title);
  setText('lead', strings.lead);
  setText('download-title', strings.download);
  setText('requirements', strings.requirements);
  setText('steps-title', strings.stepsTitle);
  setText('warning', strings.warning);
  setText('web-link', strings.web);

  const steps = document.getElementById('steps')!;
  strings.steps.forEach((step) => {
    const item = document.createElement('li');
    item.textContent = step;
    steps.append(item);
  });

  const features = document.getElementById('features')!;
  strings.features.forEach(([title, text]) => {
    const card = document.createElement('div');
    card.className = 'feature';
    const heading = document.createElement('h3');
    heading.className = 'feature-title';
    heading.textContent = title;
    const body = document.createElement('p');
    body.className = 'muted';
    body.textContent = text;
    card.append(heading, body);
    features.append(card);
  });

  const platform = detectPlatform();
  document.body.dataset.platform = platform;
  if (platform === 'ios') {
    const notice = document.getElementById('other-device')!;
    notice.textContent = strings.iosNotice;
    notice.hidden = false;
  }
  if (platform === 'desktop') {
    void renderQr();
  }

  void loadApkMeta();
}

function setText(id: string, text: string) {
  document.getElementById(id)!.textContent = text;
}

function detectPlatform(): Platform {
  const agent = navigator.userAgent;
  if (/Android/i.test(agent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}

async function loadApkMeta() {
  try {
    const response = await fetch(APK_URL, { method: 'HEAD', cache: 'no-store' });
    // Без файла сервер может отдать страницу приложения — размер и дату берём только у самого APK
    if (!response.ok || !response.headers.get('content-type')?.includes('android')) return;
    const size = Number(response.headers.get('content-length'));
    const modified = response.headers.get('last-modified');
    if (!size || !modified) return;
    const sizeText = `${(size / MEGABYTE).toLocaleString(lang, { maximumFractionDigits: 1 })} ${strings.megabytes}`;
    const dateText = new Date(modified).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' });
    setText('download-meta', strings.meta(sizeText, dateText));
  } catch {
    // Без размера и даты кнопка работает так же
  }
}

async function renderQr() {
  try {
    const QrCodeStyling = (await import('qr-code-styling')).default;
    const pageUrl = new URL('/download', window.location.origin).toString();
    const qr = new QrCodeStyling({
      width: QR_SIZE,
      height: QR_SIZE,
      type: 'svg',
      data: pageUrl,
      image: logoUrl,
      margin: 8,
      dotsOptions: { type: 'rounded', color: '#1d2021' },
      cornersSquareOptions: { type: 'extra-rounded', color: '#d65d0e' },
      cornersDotOptions: { color: '#d65d0e' },
      backgroundOptions: { color: '#fbf1c7' },
      imageOptions: { imageSize: 0.28, margin: 4 },
      qrOptions: { errorCorrectionLevel: 'M' },
    });
    const container = document.getElementById('qr')!;
    qr.append(container);
    setText('qr-title', strings.qrTitle);
    setText('qr-hint', strings.qrHint);
    document.getElementById('qr-card')!.hidden = false;
  } catch {
    // Без кода страница остаётся рабочей
  }
}
