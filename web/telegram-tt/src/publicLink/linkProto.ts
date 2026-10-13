import {
  bytesOf, concatBytes, fieldString, fieldVarint, numberOf, readFields,
} from './frames';

// Parvane (spec 022): сообщения анонимных методов ссылок шарда `cloud`
// (`proto/parvane/cloud/v1/cloud.proto`, `service LinkService`). Номера полей —
// по порядку перечисления в контракте `specs/022-public-links/contracts/links.md`,
// с единицы:
//   LinkGetRequest      { link_id = 1 }
//   LinkGetResponse     { manifest = 1 (bytes), expires_at = 2 (uint64), expired = 3 (bool) }
//   LinkDownloadRequest { link_id = 1, file_id = 2, first_chunk = 3, chunk_count = 4 }
//   LinkDownloadResponse{ size = 1 (uint64), chunks = 2 (uint32) }

export const METHOD_LINK_GET = 'cloud.link.get';
export const METHOD_LINK_DOWNLOAD = 'cloud.link.download';

export type LinkGetResponse = { manifest: Uint8Array; expiresAt: number; expired: boolean };
export type LinkDownloadResponse = { size: number; chunks: number };

export function encodeLinkGetRequest(linkId: string) {
  return fieldString(1, linkId);
}

export function decodeLinkGetResponse(bytes: Uint8Array): LinkGetResponse {
  const fields = readFields(bytes);
  return {
    manifest: bytesOf(fields, 1) || new Uint8Array(0),
    expiresAt: numberOf(fields, 2),
    expired: numberOf(fields, 3) !== 0,
  };
}

export function encodeLinkDownloadRequest(linkId: string, fileId: string, firstChunk: number, chunkCount: number) {
  return concatBytes([
    fieldString(1, linkId), fieldString(2, fileId), fieldVarint(3, firstChunk), fieldVarint(4, chunkCount),
  ]);
}

export function decodeLinkDownloadResponse(bytes: Uint8Array): LinkDownloadResponse {
  const fields = readFields(bytes);
  return { size: numberOf(fields, 1), chunks: numberOf(fields, 2) };
}
