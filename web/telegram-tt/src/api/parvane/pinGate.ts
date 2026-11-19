import {
  isPinComplete, readPinAttemptsLeft, registerPinAttempt, resetPinAttempts,
} from '../../util/pinAttempts';

// Запрос PIN хранилища (spec 041 E6): провайдер ждёт разблокировки, экран блокировки (`LockScreen`) вводит PIN.
// Прежде PIN спрашивало системное окно `window.prompt` с тремя попытками
type PinRequest = {
  user: string;
  tryPin: (pin: string) => Promise<boolean>;
  promise: Promise<boolean>;
  resolve: (isUnlocked: boolean) => void;
};

export type PinSubmitResult = {
  isUnlocked: boolean;
  attemptsLeft: number;
};

let request: PinRequest | undefined;
const listeners = new Set<NoneToVoidFunction>();

/** Провайдер: ждать, пока экран блокировки откроет хранилище. `false` — аккаунт с устройства стёрт (выход). */
export function requestPinUnlock(user: string, tryPin: (pin: string) => Promise<boolean>) {
  if (request?.user === user) return request.promise;
  let resolve!: (isUnlocked: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  request = {
    user, tryPin, promise, resolve,
  };
  notify();
  return promise;
}

/** Экран: чей PIN ждут и сколько попыток осталось. */
export function getPinRequest() {
  if (!request) return undefined;
  return { user: request.user, attemptsLeft: readPinAttemptsLeft(request.user) };
}

export function subscribeToPinRequest(listener: NoneToVoidFunction) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Экран: проверить введённый PIN. Попытка тратится до проверки; верный ввод возвращает все попытки. */
export async function submitPin(pin: string): Promise<PinSubmitResult> {
  const current = request;
  if (!current) return { isUnlocked: true, attemptsLeft: 0 };
  if (!isPinComplete(pin) || !readPinAttemptsLeft(current.user)) {
    return { isUnlocked: false, attemptsLeft: readPinAttemptsLeft(current.user) };
  }
  const attemptsLeft = registerPinAttempt(current.user);
  if (!await current.tryPin(pin)) return { isUnlocked: false, attemptsLeft };
  resetPinAttempts(current.user);
  finish(current, true);
  return { isUnlocked: true, attemptsLeft: readPinAttemptsLeft(current.user) };
}

/** Провайдер: аккаунт на устройстве стёрт — ждать PIN больше некому. */
export function dropPinRequest() {
  if (request) finish(request, false);
}

function finish(current: PinRequest, isUnlocked: boolean) {
  if (request === current) request = undefined;
  current.resolve(isUnlocked);
  notify();
}

function notify() {
  listeners.forEach((listener) => listener());
}
