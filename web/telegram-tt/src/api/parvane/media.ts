import type { SendMessageParams } from '../../types';
import type { ApiMessage } from '../types';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import { decryptBlob, encryptBlob } from './blobcrypt';
import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import { apiEntitiesToWire } from './entities';
import {
  buildWireEvent,
  TOPIC_FILE_DOWNLOAD_REQUEST,
  TOPIC_FILE_UPLOAD_CHUNK,
  TOPIC_FILE_UPLOAD_COMPLETE,
  type WireMessageContent,
} from './wire';

type MediaDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
};

type CloudUploadOptions = {
  encrypt?: boolean;
  recipients?: string[];
  publicAccess?: boolean;
};

type WireDownloadChunk = {
  ok: boolean;
  chunk_index?: number;
  total_chunks?: number;
  data?: string;
  mime_type?: string;
  error?: string;
};

type CachedMedia = { blob: Blob; mimeType: string } | undefined;

const UPLOAD_CHUNK_BYTES = 192 * 1024;
const MEDIA_TIMEOUT_MS = 30000;
const MEDIA_URL_REGEX = /^(?:photo|document)([\w-]+?)(?:\?|$)/;
const PROGRESSIVE_MEDIA_FORMAT = 1; // ApiMediaFormat.Progressive
const URL_REGEX = /https?:\/\/[^\s]+/;

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function decodeBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

export function createMediaService(deps: MediaDependencies) {
  const cacheByFileId = new Map<string, Promise<CachedMedia>>();
  // Ключи и настоящий mime приходят внутри E2E content; cloud видит только
  // нейтральный application/octet-stream.
  const keysByFileId = new Map<string, { keyB64: string; nonceB64: string }>();
  const mimeByFileId = new Map<string, string>();

  function requireConnection() {
    const connection = deps.getConnection();
    if (!connection) throw new Error('Gateway: соединение не открыто');
    return connection;
  }

  function getCloudRecipients(toAddress: string) {
    const store = deps.getStore();
    const groupInfo = store.getGroupInfo(toAddress);
    if (!groupInfo) return toAddress === store.self ? [] : [toAddress];
    return getActiveGroupMemberAddresses(groupInfo.members)
      .filter((address) => address !== store.self);
  }

  async function uploadBlob(
    blob: Blob,
    filename: string,
    mimeType: string,
    options: CloudUploadOptions = {},
  ) {
    const { encrypt = false, recipients = [], publicAccess = false } = options;
    const store = deps.getStore();
    const connection = requireConnection();
    const fileId = crypto.randomUUID();
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
    let mediaKeys: { keyB64: string; nonceB64: string } | undefined;
    if (encrypt) {
      const encrypted = await encryptBlob(bytes);
      bytes = encrypted.ciphertext;
      mediaKeys = { keyB64: encrypted.keyB64, nonceB64: encrypted.nonceB64 };
    }
    const cloudMime = encrypt ? 'application/octet-stream' : mimeType;
    const totalChunks = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES));
    for (let index = 0; index < totalChunks; index++) {
      const slice = bytes.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES);
      const chunkEvent = buildWireEvent(store.self, deps.getToken(), {
        file_id: fileId,
        chunk_index: index,
        total_chunks: totalChunks,
        data: encodeBase64(slice),
        filename,
        mime_type: cloudMime,
      });
      await connection.request(TOPIC_FILE_UPLOAD_CHUNK, JSON.stringify(chunkEvent), MEDIA_TIMEOUT_MS);
    }
    const completeEvent = buildWireEvent(store.self, deps.getToken(), {
      file_id: fileId,
      filename,
      total_chunks: totalChunks,
      size_bytes: bytes.length,
      mime_type: cloudMime,
      recipients,
      public_access: publicAccess,
    });
    const raw = await connection.request(
      TOPIC_FILE_UPLOAD_COMPLETE,
      JSON.stringify(completeEvent),
      MEDIA_TIMEOUT_MS,
    );
    const response = JSON.parse(raw) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error || 'upload.complete отказ');
    if (mediaKeys) {
      keysByFileId.set(fileId, mediaKeys);
      cacheByFileId.set(fileId, Promise.resolve({ blob, mimeType }));
    }
    return { fileId, size: blob.size, mediaKeys };
  }

  async function downloadBlob(fileId: string): Promise<CachedMedia> {
    const store = deps.getStore();
    const event = buildWireEvent(store.self, deps.getToken(), { file_id: fileId });
    const replies = await requireConnection().requestMany(
      TOPIC_FILE_DOWNLOAD_REQUEST,
      JSON.stringify(event),
    );
    const chunks = replies
      .map((reply) => JSON.parse(reply) as WireDownloadChunk)
      .filter((chunk) => chunk.ok && chunk.data !== undefined && chunk.chunk_index !== undefined)
      .sort((left, right) => left.chunk_index! - right.chunk_index!);
    if (!chunks.length) return undefined;
    const parts = chunks.map((chunk) => decodeBase64(chunk.data!));

    const keys = keysByFileId.get(fileId);
    if (keys) {
      const plain = await decryptBlob(concatBytes(parts), keys.keyB64, keys.nonceB64);
      if (!plain) return undefined;
      const mimeType = mimeByFileId.get(fileId) || 'application/octet-stream';
      return { blob: new Blob([plain as BlobPart], { type: mimeType }), mimeType };
    }
    const mimeType = chunks[0].mime_type || 'application/octet-stream';
    return { blob: new Blob(parts, { type: mimeType }), mimeType };
  }

  function downloadMedia({
    url, mediaFormat, start, end,
  }: { url: string; mediaFormat: number; start?: number; end?: number }) {
    // Progressive-запросы приходят из service worker'а с абсолютным URL
    // вида http://host/progressive/document<id>
    const normalizedUrl = url.replace(/^.*\/progressive\//, '');
    const avatarMatch = normalizedUrl.match(/^(?:avatar|profile)[^?]*\?(.+)$/);
    const mediaMatch = normalizedUrl.match(MEDIA_URL_REGEX);
    // Превью-хэши видео (document<id>?size=x) — миниатюр на проводе нет;
    // не отдавать полный файл в <img>
    if (normalizedUrl.startsWith('document') && /[?&]size=/.test(normalizedUrl)) {
      return Promise.resolve(undefined);
    }
    const fileId = avatarMatch ? avatarMatch[1] : mediaMatch?.[1];
    if (!fileId) return Promise.resolve(undefined);

    let cached = cacheByFileId.get(fileId);
    if (!cached) {
      cached = downloadBlob(fileId);
      cacheByFileId.set(fileId, cached);
      cached.catch(() => cacheByFileId.delete(fileId));
    }
    return cached.then(async (result) => {
      if (!result) return undefined;
      if (mediaFormat === PROGRESSIVE_MEDIA_FORMAT) {
        const buffer = await result.blob.arrayBuffer();
        const slice = buffer.slice(start || 0, end !== undefined ? end + 1 : undefined);
        return { arrayBuffer: slice, mimeType: result.mimeType, fullSize: buffer.byteLength };
      }
      return { dataBlob: result.blob, mimeType: result.mimeType };
    });
  }

  function rememberKeys(content: WireMessageContent) {
    if (content.file_id && content.file_key && content.file_nonce) {
      keysByFileId.set(content.file_id, { keyB64: content.file_key, nonceB64: content.file_nonce });
      if (content.mime) mimeByFileId.set(content.file_id, content.mime);
    }
  }

  function isPhotoAttachment(attachment: NonNullable<SendMessageParams['attachment']>) {
    return Boolean(
      attachment.mimeType.startsWith('image/') && attachment.quick && !attachment.shouldSendAsFile,
    );
  }

  function isVideoAttachment(attachment: NonNullable<SendMessageParams['attachment']>) {
    return Boolean(
      attachment.mimeType.startsWith('video/') && attachment.quick
      && !attachment.shouldSendAsFile && !attachment.isRoundVideo,
    );
  }

  function buildLocalContent(uuid: string, params: SendMessageParams): ApiMessage['content'] {
    const { attachment, text, entities } = params;
    const caption = text ? { text: { text } } : {};
    if (!attachment) return { text: { text: text || '', entities } };
    if (attachment.voice) {
      return {
        voice: {
          mediaType: 'voice',
          id: uuid,
          duration: attachment.voice.duration,
          waveform: attachment.voice.waveform,
          size: attachment.size,
        },
      };
    }
    if (attachment.isRoundVideo || isVideoAttachment(attachment)) {
      return {
        ...(attachment.isRoundVideo ? {} : caption),
        video: {
          mediaType: 'video',
          id: uuid,
          isRound: attachment.isRoundVideo,
          mimeType: attachment.mimeType,
          duration: attachment.quick?.duration || 1,
          fileName: attachment.filename,
          width: attachment.quick?.width,
          height: attachment.quick?.height,
          size: attachment.size,
          blobUrl: attachment.blobUrl,
          previewBlobUrl: attachment.previewBlobUrl,
        },
      };
    }
    if (attachment.audio) {
      return {
        ...caption,
        audio: {
          mediaType: 'audio',
          id: uuid,
          size: attachment.size,
          mimeType: attachment.mimeType,
          fileName: attachment.filename,
          duration: attachment.audio.duration,
          title: attachment.audio.title,
          performer: attachment.audio.performer,
        },
      };
    }
    if (isPhotoAttachment(attachment)) {
      return {
        ...caption,
        photo: {
          mediaType: 'photo',
          id: uuid,
          date: Math.floor(Date.now() / 1000),
          blobUrl: attachment.blobUrl,
          sizes: [
            { type: 'x', width: attachment.quick!.width, height: attachment.quick!.height },
            { type: 'y', width: attachment.quick!.width, height: attachment.quick!.height },
          ],
        },
      };
    }
    return {
      ...caption,
      document: {
        mediaType: 'document',
        id: uuid,
        fileName: attachment.filename,
        size: attachment.size,
        mimeType: attachment.mimeType,
        previewBlobUrl: attachment.previewBlobUrl,
      },
    };
  }

  function detectWebPage(text?: string) {
    if (!text) return undefined;
    const match = text.match(URL_REGEX);
    if (!match) return undefined;
    const url = match[0];
    try {
      return { url, site_name: new URL(url).hostname };
    } catch {
      return undefined;
    }
  }

  function messageToWireContent(message: ApiMessage): Record<string, unknown> | undefined {
    const content = message.content;
    if (content.text && !content.photo && !content.document && !content.sticker) {
      return {
        kind: 'text',
        text: content.text.text,
        entities: apiEntitiesToWire(content.text.entities),
      };
    }
    const mediaId = content.photo?.id || content.document?.id || content.sticker?.id
      || content.video?.id || content.voice?.id || content.audio?.id;
    if (!mediaId) return undefined;
    const keys = keysByFileId.get(mediaId);
    const cryptoFields = keys ? { file_key: keys.keyB64, file_nonce: keys.nonceB64 } : {};
    if (content.voice) {
      return {
        kind: 'voice',
        file_id: mediaId,
        duration_secs: Math.max(1, Math.round(content.voice.duration)),
        mime: mimeByFileId.get(mediaId) || 'audio/ogg',
        size_bytes: content.voice.size,
        waveform: content.voice.waveform,
        ...cryptoFields,
      };
    }
    if (content.video?.isRound) {
      return {
        kind: 'video_note',
        file_id: mediaId,
        duration_secs: Math.max(1, Math.round(content.video.duration)),
        width: content.video.width || 384,
        height: content.video.height || 384,
        mime: content.video.mimeType,
        size_bytes: content.video.size,
        ...cryptoFields,
      };
    }
    if (content.audio) {
      return {
        kind: 'file',
        file_id: mediaId,
        filename: content.audio.fileName,
        mime: content.audio.mimeType,
        size_bytes: content.audio.size,
        duration_secs: Math.round(content.audio.duration) || undefined,
        audio_title: content.audio.title,
        audio_performer: content.audio.performer,
        ...cryptoFields,
      };
    }
    if (content.video?.isGif) {
      return {
        kind: 'gif',
        file_id: mediaId,
        filename: content.video.fileName,
        mime: content.video.mimeType,
        width: content.video.width || 240,
        height: content.video.height || 240,
        duration_secs: Math.round(content.video.duration),
        size_bytes: content.video.size,
        ...cryptoFields,
      };
    }
    if (content.video) {
      return {
        kind: 'video',
        file_id: mediaId,
        duration_secs: Math.max(1, Math.round(content.video.duration)),
        width: content.video.width || 640,
        height: content.video.height || 480,
        mime: content.video.mimeType,
        size_bytes: content.video.size,
        ...cryptoFields,
      };
    }
    if (content.sticker) {
      return {
        kind: 'sticker',
        file_id: mediaId,
        filename: content.sticker.emoji || '⭐',
        mime: 'image/png',
        ...cryptoFields,
      };
    }
    if (content.photo) {
      return {
        kind: 'photo', file_id: mediaId, width: 0, height: 0, mime: 'image/jpeg', ...cryptoFields,
      };
    }
    return {
      kind: 'file',
      file_id: mediaId,
      filename: content.document!.fileName,
      mime: content.document!.mimeType,
      size_bytes: content.document!.size,
      ...cryptoFields,
    };
  }

  function cacheBlob(fileId: string, blob: Blob, mimeType: string) {
    cacheByFileId.set(fileId, Promise.resolve({ blob, mimeType }));
  }

  function cacheBlobIfAbsent(fileId: string, blob: Blob, mimeType: string) {
    if (!cacheByFileId.has(fileId)) cacheBlob(fileId, blob, mimeType);
  }

  return {
    buildLocalContent,
    cacheBlob,
    cacheBlobIfAbsent,
    clearCache: () => cacheByFileId.clear(),
    detectWebPage,
    downloadMedia,
    getCached: (fileId: string) => cacheByFileId.get(fileId),
    getCloudRecipients,
    isPhotoAttachment,
    isVideoAttachment,
    messageToWireContent,
    rememberKeys,
    uploadBlob,
  };
}
