import { getGlobal } from '../../../global';

import { getUserFullName } from '../../../global/helpers/users';
import { peerLabel } from './cloudStore';

/** Имя собеседника для строк доступа («Тимур»): из контактов по нику, иначе сам ник либо адрес. */
export function getPeerName(address: string) {
  const label = peerLabel(address);
  const nick = address.split('@')[0];
  const users = Object.values(getGlobal().users.byId);
  const found = users.filter((user) => user.usernames?.[0]?.username === nick);
  return (found.length === 1 && getUserFullName(found[0])) || label;
}

/** Строка под именем: «@timur» — свой сервер, «@nick@сервер» — чужой. */
export function getPeerHandle(address: string) {
  return `@${peerLabel(address)}`;
}
