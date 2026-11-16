import { setServerOffModules } from '../../util/parvaneModules';
import { preauth } from './v2/control';
import { getGatewayUrl } from './gateway';

// MODULES-1: модули, выключенные администратором сервера. Список приходит в описателе сервера; клиент
// прячет их и помнит ответ до следующего входа (без связи действует прежний)
export async function refreshServerModules(log: (message: string) => void) {
  try {
    const described = await preauth(getGatewayUrl(), 'server.describe', {});
    setServerOffModules(described.disabledModules ?? described.disabled_modules ?? []);
  } catch (err) {
    log(`список модулей сервера не получен: ${String(err)}`);
  }
}
