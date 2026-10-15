import { IS_TAURI } from './browser/globalEnvironment';
import { createCallbackManager } from './callbacks';
import { ESTABLISH_BROADCAST_CHANNEL_NAME } from './multiaccount';
import { getPasscodeHash, setPasscodeHash } from './passcode';

import Deferred from './Deferred';

const ESTABLISH_TIMEOUT = 100;

const { addCallback, runCallbacks } = createCallbackManager();
const { addCallback: addCallbackTokenDied, runCallbacks: runCallbacksTokenDied } = createCallbackManager();
const token = Number(Math.random().toString().substring(2));
const collectedTokens = new Set([token]);
const channel = new BroadcastChannel(ESTABLISH_BROADCAST_CHANNEL_NAME);

let isEstablished = false;
const initialEstablishment = new Deferred();
let masterToken: number | undefined;
let isWaitingForMaster = false;
let reestablishToken: number | undefined;
let isChannelClosed = false;
let isTokenDeadAnnounced = false;

type EstablishMessage = {
  collectedTokens: Set<number>;
  masterToken?: number;
  tokenDied?: number;
  currentPasscodeHash?: ArrayBuffer;
  reestablishToken?: number;
  shouldGiveUpMaster?: boolean;
  hasGaveUpMaster?: boolean;
};

const handleMessage = ({ data }: { data: EstablishMessage }) => {
  if (!data) return;

  if (data.currentPasscodeHash) {
    setPasscodeHash(data.currentPasscodeHash);
  }

  if (data.hasGaveUpMaster && isWaitingForMaster) {
    masterToken = token;
    isWaitingForMaster = false;
    initialEstablishment.resolve();
    runCallbacks(true);
    return;
  }

  if (data.shouldGiveUpMaster) {
    if (masterToken === token) {
      runCallbacks(false);
      channel.postMessage({ currentPasscodeHash: getPasscodeHash(), hasGaveUpMaster: true });
    }
    masterToken = data.masterToken;
    return;
  }

  if (data.tokenDied) {
    runCallbacksTokenDied(data.tokenDied);
    collectedTokens.delete(data.tokenDied);
    if (data.tokenDied === masterToken) {
      collectedTokens.delete(data.tokenDied);
      masterToken = undefined;
      isEstablished = false;
      reestablishToken = data.tokenDied;

      channel.postMessage({
        collectedTokens,
        masterToken,
        reestablishToken,
      });
      if (collectedTokens.size === 1) {
        isEstablished = true;
        masterToken = token;
        reestablishToken = undefined;
        initialEstablishment.resolve();
        runCallbacks(true);
      }
    }
  }

  if (data.collectedTokens) {
    if (!data.reestablishToken && reestablishToken) {
      return;
    }
    if (data.reestablishToken && reestablishToken !== data.reestablishToken) {
      data.collectedTokens.delete(data.reestablishToken);

      reestablishToken = data.reestablishToken;
    }
    const prevLength = collectedTokens.size;
    data.collectedTokens.forEach((l) => collectedTokens.add(l));
    if (reestablishToken) data.collectedTokens.delete(reestablishToken);

    if (!isEstablished) {
      if (data.masterToken) {
        reestablishToken = undefined;
        masterToken = data.masterToken;
        runCallbacks(masterToken === token);

        if (!isEstablished) {
          channel.postMessage({
            collectedTokens,
            masterToken,
            reestablishToken,
          });
        }
        initialEstablishment.resolve();
        isEstablished = true;
      } else if (prevLength !== collectedTokens.size) {
        channel.postMessage({
          collectedTokens,
          masterToken,
          reestablishToken,
        });
      } else {
        reestablishToken = undefined;
        masterToken = Math.max(...Array.from(collectedTokens));
        runCallbacks(masterToken === token);

        if (!isEstablished) {
          channel.postMessage({
            collectedTokens,
            masterToken,
            reestablishToken,
          });
        }
        initialEstablishment.resolve();
        isEstablished = true;
      }
    } else if (!data.masterToken) {
      channel.postMessage({
        collectedTokens,
        masterToken,
        reestablishToken,
      });
    }
  }
};

export function establishMultitabRole(shouldReestablishMasterToSelf?: boolean, isAloneTab?: boolean) {
  if (isChannelClosed) return;
  channel.addEventListener('message', handleMessage);

  channel.postMessage({ collectedTokens });

  // Единственная вкладка (замок Web Locks, B1) — хозяин сразу, без ожидания ответа: `switchMultitabRole`
  // запускает `initApi`, и соединение начинается на 100 мс раньше. Слушатель канала остаётся: вкладка,
  // открытая в тот же миг, договорится обычным путём
  if (isAloneTab) {
    masterToken = token;
    initialEstablishment.resolve();
    runCallbacks(true);
  } else {
    // Пауза — время на ответ других вкладок по BroadcastChannel: без ответа за это время мы хозяин.
    // Соединение можно открывать и сразу, а при проигрыше — рвать, но это дороже паузы
    setTimeout(() => {
      if (masterToken === undefined) {
        masterToken = token;
        initialEstablishment.resolve();
        runCallbacks(true);
      } else if (shouldReestablishMasterToSelf) {
        reestablishMasterToSelf();
      }
    }, ESTABLISH_TIMEOUT);
  }

  // Parvane: Firefox при перезагрузке теряет сообщение, отправленное в `beforeunload`, и доставляет
  // отправленное в `pagehide`. Без повтора соседняя вкладка считала главной ушедшую, и перезагруженная
  // ждала её вечно (список чатов не загружался до закрытия соседней вкладки)
  window.addEventListener('beforeunload', announceTokenDead);
  window.addEventListener('pagehide', signalTokenDead);
  // Страница вернулась из кэша «назад/вперёд» после `pagehide`: для соседей она ушла — запуск заново
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && isChannelClosed) window.location.reload();
  });
  if (IS_TAURI) window.addEventListener('unload', signalTokenDead);
}

// Отписка от общего состояния — сразу, в первом из событий ухода: уходящая вкладка не должна успеть разослать
// соседям своё состояние при выгрузке (выход из сессии), когда главной уже стала другая
function announceTokenDead() {
  if (isChannelClosed) return;
  if (!isTokenDeadAnnounced) {
    isTokenDeadAnnounced = true;
    runCallbacksTokenDied(token);
    channel.removeEventListener('message', handleMessage);
  }
  channel.postMessage({ tokenDied: token, currentPasscodeHash: getPasscodeHash() });
}

function signalTokenDead() {
  if (isChannelClosed) return;
  announceTokenDead();
  channel.close();
  isChannelClosed = true;
}

export function signalPasscodeHash() {
  channel.postMessage({ currentPasscodeHash: getPasscodeHash() });
}

export function getCurrentTabId() {
  return token;
}

export function getAllMultitabTokens() {
  return Array.from(collectedTokens);
}

export function reestablishMasterToSelf() {
  isWaitingForMaster = true;
  channel.postMessage({
    collectedTokens, masterToken: token, shouldGiveUpMaster: true,
  });
}

export const subscribeToTokenDied = addCallbackTokenDied;
export const subscribeToMasterChange = addCallback;

export const initialEstablishmentPromise = initialEstablishment.promise;

export function isCurrentTabMaster() {
  return masterToken === token;
}
