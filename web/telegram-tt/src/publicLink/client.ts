import { V2Error } from '../api/parvane/v2/transport';
import {
  CHANNEL_ANONYMOUS, decodeFrame, encodeHello, encodePong, encodeRequest, type ServerFrame,
} from './frames';
import {
  decodeLinkDownloadResponse, decodeLinkGetResponse, encodeLinkDownloadRequest, encodeLinkGetRequest,
  type LinkGetResponse, METHOD_LINK_DOWNLOAD, METHOD_LINK_GET,
} from './linkProto';

// Parvane (spec 022): анонимное соединение публичной страницы с gateway.
// Сервер держит анонимное соединение 30 с простоя, поэтому соединение
// открывается на одну операцию: Hello анонимного канала → Welcome → один
// запрос → ответ (и чанки потока) → закрытие. Серверу уходят только `link_id`
// и `file_id`; ключ ссылки страница не передаёт никуда.

const HELLO_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 20000;
const STREAM_TIMEOUT_MS = 60000;
const REQUEST_ID = 1;
// Предел поля `Request.timeout_ms`
const MAX_REQUEST_TIMEOUT_MS = 30000;

type Chunk = Extract<ServerFrame, { kind: 'chunk' }>;

function unavailable() {
  return new V2Error('ERROR_CODE_UNAVAILABLE');
}

/**
 * Один запрос по анонимному каналу. `onChunk` задан — метод потоковый:
 * обещание исполняется после последнего чанка (либо сразу, если `expectChunks`
 * по метаданным ответа вернул 0).
 */
function anonCall(
  url: string,
  clientVersion: string,
  method: string,
  body: Uint8Array,
  stream?: { onChunk: (chunk: Chunk) => void; expectChunks: (meta: Uint8Array) => number },
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      reject(unavailable());
      return;
    }
    ws.binaryType = 'arraybuffer';
    let isSettled = false;
    let isWelcomed = false;
    let meta: Uint8Array | undefined;
    let isLastSeen = false;
    let timer = setTimeout(() => fail(unavailable()), HELLO_TIMEOUT_MS);

    function finish() {
      isSettled = true;
      clearTimeout(timer);
      ws.close();
    }
    function fail(error: Error) {
      if (isSettled) return;
      finish();
      reject(error);
    }
    function done(result: Uint8Array) {
      if (isSettled) return;
      finish();
      resolve(result);
    }

    ws.onopen = () => ws.send(encodeHello(CHANNEL_ANONYMOUS, 'web', clientVersion));
    ws.onerror = () => fail(unavailable());
    ws.onclose = () => fail(unavailable());
    ws.onmessage = (message) => {
      if (isSettled || !(message.data instanceof ArrayBuffer)) return;
      let frame: ServerFrame;
      try {
        frame = decodeFrame(new Uint8Array(message.data));
      } catch {
        fail(new V2Error('ERROR_CODE_INVALID'));
        return;
      }
      if (frame.kind === 'ping') {
        ws.send(encodePong(frame.nonce));
        return;
      }
      if (!isWelcomed) {
        // На Hello сервер отвечает Welcome либо отказом в Response с id = 0
        if (frame.kind === 'response') {
          fail(new V2Error(frame.error || 'ERROR_CODE_UNSPECIFIED', frame.retryAfterMs));
          return;
        }
        if (frame.kind !== 'welcome') return;
        isWelcomed = true;
        clearTimeout(timer);
        const timeoutMs = stream ? STREAM_TIMEOUT_MS : CALL_TIMEOUT_MS;
        timer = setTimeout(() => fail(unavailable()), timeoutMs);
        ws.send(encodeRequest(REQUEST_ID, method, body, Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS)));
        return;
      }
      if (frame.kind === 'response' && frame.id === REQUEST_ID) {
        if (frame.error || !frame.ok) {
          fail(new V2Error(frame.error || 'ERROR_CODE_UNSPECIFIED', frame.retryAfterMs));
          return;
        }
        meta = frame.ok;
        // Метаданные потока приходят первыми, чанки — следом кадрами того же запроса
        if (!stream || isLastSeen || stream.expectChunks(meta) <= 0) done(meta);
        return;
      }
      if (frame.kind === 'chunk' && frame.id === REQUEST_ID && stream) {
        if (frame.error) {
          fail(new V2Error(frame.error, frame.retryAfterMs));
          return;
        }
        stream.onChunk(frame);
        if (frame.last) {
          isLastSeen = true;
          if (meta) done(meta);
        }
      }
    };
  });
}

export type LinkClient = {
  /** Зашифрованный список ссылки и её срок. */
  get: (linkId: string) => Promise<LinkGetResponse>;
  /** Чанки блоба-копии; форма ответа — как у `CloudBlobTransport.downloadBlobCap`. */
  download: (linkId: string, fileId: string, firstChunk: number, chunkCount: number) => Promise<{
    size: number; chunks: number; parts: Map<number, Uint8Array>;
  }>;
};

export function createLinkClient(gatewayUrl: string, clientVersion: string): LinkClient {
  return {
    async get(linkId) {
      return decodeLinkGetResponse(
        await anonCall(gatewayUrl, clientVersion, METHOD_LINK_GET, encodeLinkGetRequest(linkId)),
      );
    },
    async download(linkId, fileId, firstChunk, chunkCount) {
      const parts = new Map<number, Uint8Array>();
      const meta = decodeLinkDownloadResponse(await anonCall(
        gatewayUrl,
        clientVersion,
        METHOD_LINK_DOWNLOAD,
        encodeLinkDownloadRequest(linkId, fileId, firstChunk, chunkCount),
        {
          onChunk: (chunk) => {
            if (chunk.data.length) parts.set(chunk.index, chunk.data);
          },
          expectChunks: (bytes) => Math.min(
            chunkCount, Math.max(0, decodeLinkDownloadResponse(bytes).chunks - firstChunk),
          ),
        },
      ));
      return { size: meta.size, chunks: meta.chunks, parts };
    },
  };
}
