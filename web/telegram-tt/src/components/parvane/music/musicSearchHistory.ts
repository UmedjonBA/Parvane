import { callMusic } from './musicPlayer';
import { getMusicQuery } from './musicView';

const MIN_QUERY_LENGTH = 2;

/** «Недавние запросы» (на сервере): запрос, по которому что-то сделали — Enter, открыли, включили, добавили. */
export function rememberMusicQuery(query = getMusicQuery().trim()) {
  if (query.length < MIN_QUERY_LENGTH) return;
  void callMusic('parvaneMusicSearchRemember', { query }).catch(() => undefined);
}
