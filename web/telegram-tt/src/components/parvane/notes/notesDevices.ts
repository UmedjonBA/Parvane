// «Заметки»: какое устройство записало версию заметки (экран двух версий, доски `RpNotes`, `ZdNotesX`). Облако
// помнит id устройства у каждой версии; имя берётся из списка своих устройств («Firefox, Android»), вид —
// по платформе: телефон либо компьютер.

import type { ApiSession } from '../../../api/types';

import { callApi } from '../../../api/gramjs';

export type NoteDeviceKind = 'phone' | 'computer';
export type NoteDevice = { kind?: NoteDeviceKind; label?: string };

const PHONE_PLATFORM = /android|ios|iphone|ipad/i;
const COMPUTER_PLATFORM = /linux|windows|macos|mac os|desktop/i;

type Authorizations = { authorizations: Record<string, ApiSession> } | undefined;

let namesRun: Promise<Map<string, ApiSession>> | undefined;

/** Это устройство — телефон (по браузеру). */
export function isPhoneDevice() {
  return PHONE_PLATFORM.test(navigator.userAgent);
}

/** Своё устройство по id: вид и подпись; не нашлось — пусто. Список устройств запрашивается один раз. */
export async function describeNoteDevice(deviceId?: string): Promise<NoteDevice> {
  if (!deviceId) return {};
  namesRun ||= (callApi as unknown as (method: string) => Promise<Authorizations>)('fetchAuthorizations')
    .then((result) => new Map(Object.entries(result?.authorizations || {})))
    .catch(() => new Map<string, ApiSession>());
  const session = (await namesRun).get(deviceId);
  if (!session) {
    namesRun = undefined;
    return {};
  }
  const label = [session.deviceModel, session.platform].filter(Boolean).join(', ');
  return { kind: deviceKindOf(session.platform), label };
}

function deviceKindOf(platform: string): NoteDeviceKind | undefined {
  if (PHONE_PLATFORM.test(platform)) return 'phone';
  return COMPUTER_PLATFORM.test(platform) ? 'computer' : undefined;
}
