// Parvane (spec 022): словарь публичной страницы ссылки. Страница не грузит
// языковые пакеты приложения — два языка лежат здесь, выбор по языку браузера.

const en = {
  pageTitle: 'Shared files — Parvane',
  loading: 'Opening the link…',
  incompleteTitle: 'The link is incomplete',
  incompleteText: 'The part after # is missing or damaged — it holds the key, and without it the files cannot be '
    + 'decrypted. Ask the sender for the whole link and open it again.',
  notFoundTitle: 'The link is not found or has been revoked',
  notFoundText: 'The owner may have revoked it. Ask them for a new link.',
  expiredTitle: 'The link has expired',
  expiredText: 'Ask the owner to extend it — the address will stay the same.',
  rateTitle: 'Too many requests',
  rateText: 'This link is being opened too often. Wait a little and try again.',
  offlineTitle: 'No connection to the server',
  offlineText: 'Check your internet connection and try again.',
  errorTitle: 'The link could not be opened',
  errorText: 'Something went wrong. Try again a bit later.',
  retry: 'Try again',
  sharedFile: 'Someone shared a file with you',
  sharedFolder: 'Someone shared a folder with you',
  validUntil: 'link valid until {date}',
  emptyFolder: 'This folder is empty',
  files_one: '{count} file',
  files_other: '{count} files',
  download: 'Download',
  view: 'View',
  hide: 'Hide',
  cancel: 'Cancel',
  downloading: 'Downloading… {percent}%',
  decrypting: 'Opening… {percent}%',
  saved: 'Saved',
  tooLargeForBrowser: 'This file is too large to download in this browser. Open the link in Chrome or Edge on a '
    + 'computer.',
  integrityError: 'The file is damaged or has been altered on the server. It was not saved.',
  fileGone: 'The file is no longer available: the link was revoked or has expired.',
  fileRate: 'Too many downloads from this link. Wait a little and try again.',
  fileOffline: 'The connection was lost. Try again.',
  previewFailed: 'This file cannot be shown here. Download it instead.',
  footNote: 'Decrypted in this browser · no account needed',
  footKey: 'The key is the part of the address after #. The browser does not send it to the server.',
  bytes: 'B',
  kb: 'KB',
  mb: 'MB',
  gb: 'GB',
};

const ru: typeof en = {
  pageTitle: 'Файлы по ссылке — Parvane',
  loading: 'Открываем ссылку…',
  incompleteTitle: 'Ссылка неполная',
  incompleteText: 'Нет части после # либо она повреждена — в ней ключ, без него файлы не расшифровать. '
    + 'Попросите отправителя прислать ссылку целиком и откройте её снова.',
  notFoundTitle: 'Ссылка не найдена или отозвана',
  notFoundText: 'Возможно, владелец её отозвал. Попросите у него новую ссылку.',
  expiredTitle: 'Срок ссылки истёк',
  expiredText: 'Попросите владельца продлить её — адрес останется прежним.',
  rateTitle: 'Слишком часто',
  rateText: 'Эту ссылку открывают слишком часто. Подождите немного и попробуйте снова.',
  offlineTitle: 'Нет связи с сервером',
  offlineText: 'Проверьте подключение к интернету и попробуйте снова.',
  errorTitle: 'Не удалось открыть ссылку',
  errorText: 'Что-то пошло не так. Попробуйте немного позже.',
  retry: 'Повторить',
  sharedFile: 'С вами поделились файлом',
  sharedFolder: 'С вами поделились папкой',
  validUntil: 'ссылка действует до {date}',
  emptyFolder: 'Папка пуста',
  files_one: '{count} файл',
  files_other: '{count} файлов',
  download: 'Скачать',
  view: 'Посмотреть',
  hide: 'Скрыть',
  cancel: 'Отмена',
  downloading: 'Скачивание… {percent}%',
  decrypting: 'Открываем… {percent}%',
  saved: 'Сохранено',
  tooLargeForBrowser: 'Файл слишком большой, чтобы скачать его в этом браузере. Откройте ссылку в Chrome или Edge '
    + 'на компьютере.',
  integrityError: 'Файл повреждён либо подменён на сервере. Он не сохранён.',
  fileGone: 'Файл больше недоступен: ссылка отозвана либо её срок истёк.',
  fileRate: 'По этой ссылке скачивают слишком часто. Подождите немного и попробуйте снова.',
  fileOffline: 'Связь прервалась. Попробуйте снова.',
  previewFailed: 'Этот файл не получается показать здесь. Скачайте его.',
  footNote: 'Расшифровывается в этом браузере · аккаунт не нужен',
  footKey: 'Ключ — часть адреса после #. Браузер не отправляет её на сервер.',
  bytes: 'Б',
  kb: 'КБ',
  mb: 'МБ',
  gb: 'ГБ',
};

export type LinkStrings = typeof en;
export type LinkLang = 'en' | 'ru';

export function pickLang(language: string | undefined): LinkLang {
  return (language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function stringsFor(lang: LinkLang): LinkStrings {
  return lang === 'ru' ? ru : en;
}

export function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** «3 файла / 5 файлов»: русские формы — по правилу числа, английские — one/other. */
export function filesText(lang: LinkLang, count: number) {
  if (lang === 'ru') {
    const tail = count % 100;
    const last = count % 10;
    const isFew = last >= 2 && last <= 4;
    const word = tail >= 11 && tail <= 14 ? 'файлов' : last === 1 ? 'файл' : isFew ? 'файла' : 'файлов';
    return `${count} ${word}`;
  }
  return fill(count === 1 ? en.files_one : en.files_other, { count });
}

export function sizeText(strings: LinkStrings, bytes: number) {
  const units = [strings.bytes, strings.kb, strings.mb, strings.gb];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
