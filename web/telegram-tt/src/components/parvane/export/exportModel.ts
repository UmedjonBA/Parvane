// «Выгрузка данных»: модель архива — что лежит в нём, как называются файлы и как выглядят страницы чатов.
// Чистые функции без обращений к провайдеру: данные приходят снимком (`ExportSnapshot`), собранным на
// устройстве из расшифрованного кэша истории. Вид — как у выгрузки Telegram Desktop: на чат папка с
// `messages.html` (читать глазами) и `messages.json` (для программ), вложения — рядом в `media/`.

import type { WireMessageContent } from '../../../api/parvane/wire';

export type ExportChatKind = 'user' | 'group' | 'channel' | 'saved';

/** Сообщение чата в снимке (из строки кэша истории). */
export type ExportSourceMessage = {
  uuid: string;
  from: string;
  fromName: string;
  isOutgoing: boolean;
  /** Unix-секунды. */
  ts: number;
  replyTo?: string;
  edited?: boolean;
  editedAt?: number;
  pinned?: boolean;
  content: WireMessageContent;
  reactions?: { emoji: string; count: number }[];
};

export type ExportSourceChat = {
  address: string;
  kind: ExportChatKind;
  title: string;
  messages: ExportSourceMessage[];
};

export type ExportContact = { address: string; name: string; isExplicit: boolean };

export type ExportSnapshot = {
  self: string;
  selfName: string;
  chats: ExportSourceChat[];
  contacts: ExportContact[];
};

export type ExportMediaStatus = 'included' | 'not_included' | 'unavailable';

export type ExportMedia = {
  kind: string;
  fileId: string;
  /** Путь в архиве относительно папки чата (`media/…`). */
  path: string;
  fileName?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  status: ExportMediaStatus;
};

/** Сообщение, как оно ляжет в архив: номер в чате, ответ — номером, вложение — путём. */
export type ExportMessage = {
  id: number;
  uuid: string;
  type: 'message' | 'service';
  kind: string;
  ts: number;
  from: string;
  fromName: string;
  isOutgoing: boolean;
  text: string;
  replyToId?: number;
  edited?: boolean;
  editedAt?: number;
  pinned?: boolean;
  forwardedFrom?: string;
  media?: ExportMedia;
  poll?: { question: string; options: string[] };
  location?: { lat: number; long: number };
  article?: { title: string; markdown: string };
  reactions?: { emoji: string; count: number }[];
  /** Служебное: режим «усиленная приватность» включён/выключен. */
  action?: 'privacy_on' | 'privacy_off';
};

export type ExportChat = {
  /** Папка чата в архиве (`chats/…`), без завершающей косой. */
  dir: string;
  address: string;
  kind: ExportChatKind;
  title: string;
  messages: ExportMessage[];
};

/** Подписи страниц архива (на языке интерфейса). */
export type ExportLabels = {
  title: string;
  chats: string;
  planner: string;
  notes: string;
  contacts: string;
  cloud: string;
  savedMessages: string;
  replyTo: string;
  forwardedFrom: string;
  edited: string;
  mediaNotIncluded: string;
  mediaUnavailable: string;
  poll: string;
  location: string;
  messages: string;
  exportedAt: string;
  privacyOn: string;
  privacyOff: string;
};

export const DEFAULT_EXPORT_LABELS: ExportLabels = {
  title: 'Parvane data export',
  chats: 'Chats',
  planner: 'Planner',
  notes: 'Notes',
  contacts: 'Contacts',
  cloud: 'Cloud files',
  savedMessages: 'Saved Messages',
  replyTo: 'In reply to',
  forwardedFrom: 'Forwarded from',
  edited: 'edited',
  mediaNotIncluded: 'Media not included',
  mediaUnavailable: 'Media unavailable',
  poll: 'Poll',
  location: 'Location',
  messages: 'messages',
  exportedAt: 'Exported',
  privacyOn: 'enabled enhanced privacy',
  privacyOff: 'disabled enhanced privacy',
};

/** Виды содержимого с файлом, который выгружается в `media/`. */
const MEDIA_KINDS = new Set(['photo', 'video', 'video_note', 'voice', 'file', 'gif']);
/** Служебные строки протокола, которые читателю не нужны. */
const SKIPPED_KINDS = new Set(['poll_vote', 'poll_close', 'encrypted', 'group_encrypted', 'token']);

const FILE_NAME_MAX = 80;
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/markdown': '.md',
};

const DEFAULT_EXT_BY_KIND: Record<string, string> = {
  photo: '.jpg',
  video: '.mp4',
  video_note: '.mp4',
  voice: '.ogg',
  gif: '.webm',
};

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Имя файла без путей и запрещённых в Windows/macOS/Linux символов; пустое — `fallback`. */
export function sanitizeFileName(name: string, fallback = 'file') {
  let clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    // Знаки направления текста и нулевой ширины (маскируют расширение: `fdp.exe` → `exe.pdf`)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    // Части-«точки» (`..` из пути) убираются: `../../a` → `_a`
    .replace(/(^|_)\.+(?=_|$)/g, '$1')
    .replace(/_{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (clean.length > FILE_NAME_MAX) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
    clean = clean.slice(0, FILE_NAME_MAX - ext.length).trim() + ext;
  }
  const stem = clean.replace(/\..*$/, '');
  if (!clean || RESERVED_NAMES.test(stem)) return fallback;
  return clean;
}

/** Свободное имя среди занятых (без учёта регистра): `a.jpg` → `a (2).jpg`. Имя запоминается как занятое. */
export function uniqueName(taken: Set<string>, name: string) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function extForMime(mime?: string) {
  if (!mime) return '';
  return EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] || '';
}

function pad(value: number, size = 2) {
  return String(value).padStart(size, '0');
}

/** `YYYY-MM-DD` по местному времени. */
export function formatDay(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Имя архива: `parvane-export-<ник>-<YYYY-MM-DD>.zip` (ник — без домена сервера). */
export function exportArchiveName(address: string, date: Date) {
  const nick = sanitizeFileName(address.split('@')[0] || '', 'user').replace(/\s+/g, '_');
  return `parvane-export-${nick}-${formatDay(date)}.zip`;
}

function formatTime(ts: number) {
  const date = new Date(ts * 1000);
  return `${formatDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Текст сообщения для архива: подпись к вложению, текст, вопрос опроса и т. п. */
function textOf(content: WireMessageContent) {
  switch (content.kind) {
    case 'poll':
      return content.question || '';
    case 'sticker':
      return content.filename || content.text || '';
    case 'article':
      return content.title || content.text || '';
    case 'task_offer':
      return content.text || content.name || '';
    case 'cloud_invite':
      return content.text || content.name || '';
    default:
      return content.caption ?? content.text ?? '';
  }
}

function mediaName(content: WireMessageContent, index: number) {
  const ext = extForMime(content.mime) || DEFAULT_EXT_BY_KIND[content.kind] || '';
  const given = content.filename ? sanitizeFileName(content.filename, '') : '';
  const base = given || `${content.kind}-${index}${ext}`;
  return `${pad(index, 5)}-${base}`;
}

/**
 * Сообщения чата в виде для архива. Номера — по порядку (с 1), ответы — номерами; у вложений путь
 * `media/<номер>-<имя>` и статус: `not_included`, если медиа не выгружаются, иначе `included`
 * (неудачное скачивание помечает `unavailable` уже при сборке архива).
 */
export function buildChatMessages(chat: ExportSourceChat, includeMedia: boolean): ExportMessage[] {
  const visible = chat.messages.filter((message) => !SKIPPED_KINDS.has(message.content.kind));
  const idByUuid = new Map<string, number>();
  visible.forEach((message, i) => idByUuid.set(message.uuid, i + 1));
  const taken = new Set<string>();
  return visible.map((source, i) => {
    const { content } = source;
    const id = i + 1;
    const message: ExportMessage = {
      id,
      uuid: source.uuid,
      type: content.kind === 'chat_mode' ? 'service' : 'message',
      kind: content.kind,
      ts: source.ts,
      from: source.from,
      fromName: source.fromName,
      isOutgoing: source.isOutgoing,
      text: textOf(content),
    };
    const replyToId = source.replyTo ? idByUuid.get(source.replyTo) : undefined;
    if (replyToId) message.replyToId = replyToId;
    if (source.edited) {
      message.edited = true;
      if (source.editedAt) message.editedAt = source.editedAt;
    }
    if (source.pinned) message.pinned = true;
    if (content.kind === 'chat_mode') message.action = content.l2 ? 'privacy_on' : 'privacy_off';
    if (content.forwarded_from) message.forwardedFrom = content.forwarded_name || content.forwarded_from;
    if (source.reactions?.length) message.reactions = source.reactions.map(({ emoji, count }) => ({ emoji, count }));
    if (content.kind === 'poll') {
      message.poll = {
        question: content.question || '',
        options: (content.options || []).map((option) => String(option)),
      };
    }
    if (content.kind === 'location' && content.lat !== undefined && content.long !== undefined) {
      message.location = { lat: content.lat, long: content.long };
    }
    if (content.kind === 'article' && content.markdown !== undefined) {
      message.article = { title: content.title || '', markdown: content.markdown };
    }
    if (MEDIA_KINDS.has(content.kind) && content.file_id) {
      message.media = {
        kind: content.kind,
        fileId: content.file_id,
        path: `media/${uniqueName(taken, mediaName(content, id))}`,
        fileName: content.filename,
        mime: content.mime,
        size: content.size_bytes,
        width: content.width,
        height: content.height,
        duration: content.duration_secs,
        status: includeMedia ? 'included' : 'not_included',
      };
    }
    return message;
  });
}

/** Папки чатов: `chats/<номер>-<название>` — номер держит порядок и различает одинаковые названия. */
export function assignChatDirs(chats: ExportSourceChat[], labels: ExportLabels, includeMedia: boolean): ExportChat[] {
  const taken = new Set<string>();
  return chats.map((chat, i) => {
    const title = chat.kind === 'saved' ? labels.savedMessages : chat.title;
    const name = sanitizeFileName(title, chat.kind);
    return {
      dir: `chats/${uniqueName(taken, `${pad(i + 1, 3)}-${name}`)}`,
      address: chat.address,
      kind: chat.kind,
      title,
      messages: buildChatMessages(chat, includeMedia),
    };
  });
}

/** Относительная ссылка на файл архива: каждая часть пути — с процентным кодированием. */
export function hrefOf(path: string) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function isoOf(ts: number) {
  return new Date(ts * 1000).toISOString();
}

/** `messages.json` чата: поля — snake_case, как в выгрузке Telegram Desktop. */
export function renderChatJson(chat: ExportChat) {
  return JSON.stringify({
    name: chat.title,
    type: chat.kind,
    id: chat.address,
    messages: chat.messages.map((m) => ({
      id: m.id,
      uuid: m.uuid,
      type: m.type,
      kind: m.kind,
      date: isoOf(m.ts),
      date_unixtime: String(m.ts),
      from: m.fromName,
      from_id: m.from,
      ...(m.isOutgoing ? { outgoing: true } : {}),
      ...(m.edited ? { edited: m.editedAt ? isoOf(m.editedAt) : true } : {}),
      ...(m.pinned ? { pinned: true } : {}),
      ...(m.replyToId ? { reply_to_message_id: m.replyToId } : {}),
      ...(m.forwardedFrom ? { forwarded_from: m.forwardedFrom } : {}),
      text: m.text,
      ...(m.media ? {
        media: {
          kind: m.media.kind,
          ...(m.media.status === 'included' ? { file: m.media.path } : {}),
          status: m.media.status,
          ...(m.media.fileName ? { file_name: m.media.fileName } : {}),
          ...(m.media.mime ? { mime_type: m.media.mime } : {}),
          ...(m.media.size ? { size: m.media.size } : {}),
          ...(m.media.width ? { width: m.media.width, height: m.media.height } : {}),
          ...(m.media.duration ? { duration_seconds: m.media.duration } : {}),
        },
      } : {}),
      ...(m.poll ? { poll: m.poll } : {}),
      ...(m.location ? { location: m.location } : {}),
      ...(m.article ? { article: m.article } : {}),
      ...(m.reactions ? { reactions: m.reactions } : {}),
      ...(m.action ? { action: m.action } : {}),
    })),
  }, undefined, 2);
}

const PAGE_STYLE = `
body{margin:0;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f4f5;color:#111}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:12px 16px}
header h1{margin:0;font-size:18px}header a{color:#3a7bd5;text-decoration:none;font-size:14px}
main{max-width:760px;margin:0 auto;padding:12px 16px 40px}
.msg{background:#fff;border-radius:10px;padding:8px 12px;margin:6px 0;max-width:85%}
.msg.out{margin-left:auto;background:#e3f2fd}.msg.service{background:none;text-align:center;color:#666;max-width:none}
.meta{font-size:12px;color:#777;display:flex;gap:8px}.from{font-weight:600;color:#3a7bd5}
.reply,.fwd{font-size:13px;color:#555;border-left:3px solid #3a7bd5;padding-left:6px;margin:4px 0}
.text{white-space:pre-wrap;word-wrap:break-word}.media img,.media video{max-width:100%;border-radius:6px;margin-top:4px}
.missing{font-style:italic;color:#888}.reactions{font-size:13px;margin-top:4px}
ul{padding-left:20px}li{margin:4px 0}
@media (prefers-color-scheme:dark){body{background:#17181a;color:#eee}header,.msg{background:#232427;border-color:#333}
.msg.out{background:#1e3a52}.reply,.fwd{color:#bbb}}
`;

function page(title: string, body: string, back?: string) {
  return '<!DOCTYPE html>\n<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>`
    + `<header>${back ? `<a href="${escapeHtml(back)}">←</a> ` : ''}<h1>${escapeHtml(title)}</h1></header>`
    + `<main>${body}</main></body></html>\n`;
}

function renderMedia(media: ExportMedia, labels: ExportLabels) {
  if (media.status !== 'included') {
    const label = media.status === 'unavailable' ? labels.mediaUnavailable : labels.mediaNotIncluded;
    const name = media.fileName ? `: ${escapeHtml(media.fileName)}` : '';
    return `<div class="media missing">${escapeHtml(label)}${name}</div>`;
  }
  const href = escapeHtml(hrefOf(media.path));
  const mime = media.mime || '';
  if (media.kind === 'photo' || mime.startsWith('image/')) {
    return `<div class="media"><a href="${href}"><img src="${href}" alt="" loading="lazy"></a></div>`;
  }
  if (media.kind === 'video' || media.kind === 'video_note' || media.kind === 'gif') {
    return `<div class="media"><video src="${href}" controls preload="none"></video></div>`;
  }
  if (media.kind === 'voice' || mime.startsWith('audio/')) {
    return `<div class="media"><audio src="${href}" controls preload="none"></audio></div>`;
  }
  const name = media.fileName || media.path.slice('media/'.length);
  return `<div class="media"><a href="${href}">${escapeHtml(name)}</a></div>`;
}

/** `messages.html` чата: лента сообщений, ответы — ссылками на якоря `#message-<номер>`. */
export function renderChatHtml(chat: ExportChat, labels: ExportLabels) {
  const byId = new Map(chat.messages.map((m) => [m.id, m]));
  const items = chat.messages.map((m) => {
    if (m.type === 'service') {
      const what = m.action === 'privacy_on' ? labels.privacyOn
        : m.action === 'privacy_off' ? labels.privacyOff : m.kind;
      return `<div class="msg service" id="message-${m.id}">${escapeHtml(m.fromName)} ${escapeHtml(what)}`
        + ` · ${escapeHtml(formatTime(m.ts))}</div>`;
    }
    const parts: string[] = [];
    parts.push(`<div class="meta"><span class="from">${escapeHtml(m.fromName)}</span>`
      + `<span title="${escapeHtml(isoOf(m.ts))}">${escapeHtml(formatTime(m.ts))}</span>`
      + `${m.edited ? `<span>${escapeHtml(labels.edited)}</span>` : ''}</div>`);
    if (m.forwardedFrom) {
      parts.push(`<div class="fwd">${escapeHtml(labels.forwardedFrom)} ${escapeHtml(m.forwardedFrom)}</div>`);
    }
    if (m.replyToId) {
      const target = byId.get(m.replyToId);
      const preview = target ? target.text.slice(0, 80) || target.kind : '';
      parts.push(`<div class="reply"><a href="#message-${m.replyToId}">${escapeHtml(labels.replyTo)}</a>`
        + `${preview ? ` ${escapeHtml(preview)}` : ''}</div>`);
    }
    if (m.media) parts.push(renderMedia(m.media, labels));
    if (m.poll) {
      parts.push(`<div class="text">${escapeHtml(labels.poll)}: ${escapeHtml(m.poll.question)}</div><ul>`
        + `${m.poll.options.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`);
    } else if (m.article) {
      parts.push(`<div class="text"><b>${escapeHtml(m.article.title)}</b>\n${escapeHtml(m.article.markdown)}</div>`);
    } else if (m.location) {
      const { lat, long } = m.location;
      const url = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${long}#map=16/${lat}/${long}`;
      parts.push(`<div class="text">${escapeHtml(labels.location)}: `
        + `<a href="${escapeHtml(url)}" rel="noreferrer">${lat}, ${long}</a></div>`);
    } else if (m.text) {
      parts.push(`<div class="text">${escapeHtml(m.text)}</div>`);
    }
    if (m.reactions?.length) {
      const reactions = m.reactions.map((r) => `${escapeHtml(r.emoji)} ${r.count}`).join(' · ');
      parts.push(`<div class="reactions">${reactions}</div>`);
    }
    return `<div class="msg${m.isOutgoing ? ' out' : ''}" id="message-${m.id}">${parts.join('')}</div>`;
  });
  return page(chat.title, items.join('\n'), '../../index.html');
}

export type ExportIndexSections = {
  planner?: string;
  notes?: string[];
  contacts?: string;
  cloud?: string[];
};

/** `index.html` в корне архива: ссылки на чаты и прочие разделы. */
export function renderIndexHtml(
  owner: { address: string; name: string }, chats: ExportChat[], sections: ExportIndexSections,
  labels: ExportLabels, exportedAt: Date,
) {
  const link = (path: string, text: string) => `<a href="${escapeHtml(hrefOf(path))}">${escapeHtml(text)}</a>`;
  const blocks: string[] = [];
  blocks.push(`<p>${escapeHtml(owner.name)} (@${escapeHtml(owner.address.split('@')[0])}) · `
    + `${escapeHtml(labels.exportedAt)} ${escapeHtml(formatTime(Math.floor(exportedAt.getTime() / 1000)))}</p>`);
  blocks.push(`<h2>${escapeHtml(labels.chats)}</h2><ul>${chats.map((chat) => `<li>${
    link(`${chat.dir}/messages.html`, chat.title)} — ${chat.messages.length} ${escapeHtml(labels.messages)} (${
    link(`${chat.dir}/messages.json`, 'JSON')})</li>`).join('')}</ul>`);
  const list = (title: string, paths: string[]) => (
    `<h2>${escapeHtml(title)}</h2><ul>${paths.map((p) => `<li>${link(p, p)}</li>`).join('')}</ul>`
  );
  if (sections.planner) blocks.push(list(labels.planner, [sections.planner]));
  if (sections.notes) blocks.push(list(labels.notes, sections.notes));
  if (sections.contacts) blocks.push(list(labels.contacts, [sections.contacts]));
  if (sections.cloud) blocks.push(list(labels.cloud, sections.cloud));
  return page(labels.title, blocks.join('\n'));
}
