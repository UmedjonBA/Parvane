import { createSignal } from './signals';

// Parvane (доска `ZpChat`): почему сообщение не доставлено — подпись под ним «Не доставлено: …». Ключ — чат и
// местный id сообщения, значение — ключ словаря с причиной (отказ федерации); без причины — просто «не доставлено»

const [getSendFailures, setSendFailures] = createSignal<Record<string, string>>({});

export { getSendFailures };

export function sendFailureKey(chatId: string, messageId: number) {
  return `${chatId}:${messageId}`;
}

export function noteSendFailure(chatId: string, messageId: number, reasonKey?: string) {
  if (!reasonKey) return;
  setSendFailures({ ...getSendFailures(), [sendFailureKey(chatId, messageId)]: reasonKey });
}
