import { createSignal } from '../../../../util/signals';

// «Подтвердите вход» на телефоне — отдельный экран (доска `PhAuth`): экран «Устройства» сообщает шапке, что сейчас
// показывает только его, и шапка называется «Подтвердите вход»
const [getIsConfirmSignInScreen, setIsConfirmSignInScreen] = createSignal(false);

export { getIsConfirmSignInScreen, setIsConfirmSignInScreen };
