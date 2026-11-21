import type { Protocol } from './engine';

import { base64ToBytes } from './base64';

// «Версия сервера» в «О приложении» (доски `RpProfileA`, `ZdProfileX`): сервер сообщает о себе только версию
// протокола — её несёт подписанный описатель из Welcome (`ServerDescriptor.proto_major/proto_minor`). Подпись уже
// проверил `verifyServerDescriptor`; здесь только чтение полей. Не разобрать — `undefined`
type DescriptorJson = {
  protoMajor?: number; proto_major?: number; protoMinor?: number; proto_minor?: number;
};

export function readServerProtoVersion(pv: Protocol, signedDescriptor: Uint8Array) {
  try {
    const signed = JSON.parse(pv.decodeMessage('parvane.core.v2.SignedServerDescriptor', signedDescriptor)) as {
      descriptor?: string;
    };
    if (!signed.descriptor) return undefined;
    const inner = JSON.parse(pv.decodeMessage(
      'parvane.core.v2.ServerDescriptor', base64ToBytes(signed.descriptor),
    )) as DescriptorJson;
    const major = inner.protoMajor ?? inner.proto_major ?? 0;
    const minor = inner.protoMinor ?? inner.proto_minor ?? 0;
    return major ? `${major}.${minor}` : undefined;
  } catch {
    return undefined;
  }
}
