import type { BlobSession, CloudBlobTransport } from './cloudBlobs';
import type { CloudSync } from './v2/cloud';
import type { WireMessageContent } from './wire';

import { relayCloudBlob } from './cloudBlobs';

// Parvane (spec 041, CLOUD-3): доступ к файлу копией. Собеседник прислал файл «Файлов» сообщением с
// `Media.to_files` — устройство получателя кладёт серверную копию блоба (`cloud.blob.copy` по секрету вложения,
// в квоту получателя) в корень своего диска узлом с `from` = автор; экран показывает такой файл в «Доступных мне».
// Узел получает id из id сообщения: другие устройства получателя и повторный показ сообщения узел не удваивают.
// Файл с другого сервера (федерация) серверной копией не взять — устройство получателя переливает тот же шифртекст
// со своего сервера на свой (`relayCloudBlob`, квота получателя); ключ файла прежний.

type Deps = {
  log: (message: string) => void;
  cloud: () => CloudSync;
  blobCall: <T>(method: string, request: unknown) => Promise<T>;
  downloadBlobCap: BlobSession['downloadBlobCap'];
  uploadBlobChunk?: CloudBlobTransport['uploadBlobChunk'];
  setBlobDomain: (fileId: string, domain?: string) => void;
  serverDomain: () => string | undefined;
  loadRecord: <T>(key: string) => Promise<T | undefined>;
  saveRecord: (key: string, value: unknown) => Promise<void>;
};

type CopyReply = { fileId?: string; file_id?: string; chunks?: number };

const RECORD = 'cloud-received';
const RECORD_KEEP = 500;
const NODE_LABEL = 'parvane/cloud-received/v1/';
const NODE_ID_BYTES = 16;
const CAPABILITY_BYTES = 32;
const DRIVE_BUCKET = 'BLOB_BUCKET_DRIVE';
// Нет связи либо диск ещё не готов — повторить позже, не больше стольких раз
const RETRY_MS = 15000;
const RETRY_TIMES = 4;
const BAD_NAME_CHARS = /[/\\\p{Cc}]/gu;
const NAME_MAX_BYTES = 255;

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

/** Id узла копии — из id сообщения: одинаков на всех устройствах получателя. */
export async function receivedNodeId(opId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${NODE_LABEL}${opId}`));
  return toHex(new Uint8Array(digest).slice(0, NODE_ID_BYTES));
}

/** Имя из чужого сообщения — к допустимому для движка (как `cloudModel.normalizeName`). */
function cleanName(name: string | undefined) {
  let clean = (name || '').replace(BAD_NAME_CHARS, '_').trim();
  while (clean && new TextEncoder().encode(clean).length > NAME_MAX_BYTES) clean = clean.slice(0, -1);
  clean = clean.trim();
  return !clean || clean === '.' || clean === '..' ? 'file' : clean;
}

export function createCloudReceiver(deps: Deps) {
  let done: string[] | undefined;
  const running = new Set<string>();

  async function isDone(opId: string) {
    done = done || (await deps.loadRecord<string[]>(RECORD).catch(() => undefined)) || [];
    return done.includes(opId);
  }

  async function markDone(opId: string) {
    done = [...(done || []), opId].slice(-RECORD_KEEP);
    await deps.saveRecord(RECORD, done).catch(() => undefined);
  }

  function hasNode(id: string) {
    const cloud = deps.cloud();
    const root = cloud.containers().find((c) => c.kind === 'root')?.id;
    const json = root ? cloud.stateJson(root) : undefined;
    return Boolean(json && (JSON.parse(json) as { nodes?: { id: string }[] }).nodes?.some((n) => n.id === id));
  }

  /** Копия блоба вложения в свой диск: на своём сервере — серверная, с другого — переливом через устройство. */
  async function copyBlob(wire: WireMessageContent, isForeign: boolean) {
    if (isForeign) {
      deps.setBlobDomain(wire.file_id!, wire.blob_domain);
      return relayCloudBlob(deps, { fileId: wire.file_id!, capability: wire.capability! });
    }
    const capability = crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', capability));
    const reply = await deps.blobCall<CopyReply>('cloud.blob.copy', {
      file_id: wire.file_id, capability: wire.capability, bucket: DRIVE_BUCKET, capability_hash: toBase64(hash),
    });
    const fileId = reply.fileId || reply.file_id;
    if (!fileId) throw new Error('copy: no file id');
    return { fileId, capability: toBase64(capability), chunks: reply.chunks || 1 };
  }

  async function copy(wire: WireMessageContent, from: string, opId: string, self: string, isForeign: boolean) {
    const id = await receivedNodeId(opId);
    if (hasNode(id)) return;
    const { fileId, capability, chunks } = await copyBlob(wire, isForeign);
    const size = Number(wire.size_bytes || 0);
    await deps.cloud().apply('root', [{
      op: 'create',
      id,
      kind: 'file',
      name: cleanName(wire.filename),
      mtime: Date.now(),
      from,
      blob: {
        fileId,
        key: wire.file_key,
        nonce: wire.file_nonce,
        capability,
        size,
        chunks,
        mime: wire.mime || 'application/octet-stream',
        // Копия — блоб получателя: стирает её (корзина, вытесненная версия) его устройство
        uploader: self,
      },
    }]);
  }

  /** Файл из сообщения с `to_files` — копией в «Доступные мне» (вложение с чужого сервера — переливом). */
  async function receive(args: { wire: WireMessageContent; from: string; opId: string; self: string }, attempt = 0) {
    const {
      wire, from, opId, self,
    } = args;
    if (!wire.file_id || !wire.capability || !wire.file_key || !wire.file_nonce) return;
    const own = deps.serverDomain()?.toLowerCase();
    const isForeign = Boolean(wire.blob_domain && own && wire.blob_domain.toLowerCase() !== own);
    if (running.has(opId) || await isDone(opId)) return;
    running.add(opId);
    try {
      await copy(wire, from, opId, self, isForeign);
      await markDone(opId);
      deps.log('облако: присланный файл скопирован в «Доступные мне»');
    } catch (e) {
      deps.log(`облако: присланный файл не скопирован: ${String(e)}`);
      if (attempt + 1 < RETRY_TIMES) {
        setTimeout(() => void receive(args, attempt + 1), RETRY_MS);
      }
    } finally {
      running.delete(opId);
    }
  }

  return { receive };
}
