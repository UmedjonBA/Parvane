import type {
  ApiUpdateAuthorizationError,
  ApiUpdateAuthorizationState,
  ApiUpdateConnectionState,
  ApiUpdateCurrentUser,
} from '../../../api/types';
import type { LangCode } from '../../../types';
import type { RequiredGlobalActions } from '../../index';
import type { ActionReturnType, GlobalState } from '../../types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { oldSetLanguage } from '../../../util/oldLangProvider';
import { updateSessionUserId } from '../../../util/sessions';
import { forceWebsync } from '../../../util/websync';
import {
  addActionHandler, getActions, getGlobal, setGlobal,
} from '../../index';
import { updateUser, updateUserFullInfo } from '../../reducers';
import { updateAuth } from '../../reducers/auth';
import { updateTabState } from '../../reducers/tabs';
import { selectTabState } from '../../selectors';
import { selectSharedSettings } from '../../selectors/sharedState';

addActionHandler('apiUpdate', (global, actions, update): ActionReturnType => {
  switch (update['@type']) {
    case 'updateApiReady':
      onUpdateApiReady(global);
      break;

    case 'updateAuthorizationState':
      onUpdateAuthorizationState(global, update);
      break;

    case 'updateAuthorizationError':
      onUpdateAuthorizationError(global, update);
      break;

    case 'updateConnectionState':
      onUpdateConnectionState(global, actions, update);
      break;

    case 'updateCurrentUser':
      onUpdateCurrentUser(global, update);
      break;

    case 'requestSync':
      // Parvane: полный ресинк (импорт ключей / авто-линковка истории) —
      // чат-лист уже помечен загруженным, и loadAllChats был бы no-op;
      // снимаем флаг, чтобы sync честно перечитал чаты и заменил сообщения
      global = {
        ...global,
        chats: { ...global.chats, isFullyLoaded: {} },
      };
      setGlobal(global);
      actions.sync();
      break;
  }
});

function onUpdateApiReady<T extends GlobalState>(global: T) {
  void oldSetLanguage(selectSharedSettings(global).language as LangCode);
}

function onUpdateAuthorizationState<T extends GlobalState>(global: T, update: ApiUpdateAuthorizationState) {
  const wasAuthReady = global.auth.state === 'authorizationStateReady';
  const authState = update.authorizationState;

  global = updateAuth(global, {
    state: authState,
    isLoading: false,
  });
  setGlobal(global);
  global = getGlobal();

  switch (authState) {
    case 'authorizationStateLoggingOut':
      void forceWebsync(false);

      global = updateAuth(global, {
        isLoggingOut: true,
      });
      setGlobal(global);
      break;
    case 'authorizationStateWaitCode':
      global = updateAuth(global, {
        isCodeViaApp: update.isCodeViaApp,
      });
      setGlobal(global);
      break;
    case 'authorizationStateWaitPassword':
      global = updateAuth(global, {
        hint: update.hint,
      });

      if (update.noReset) {
        global = updateAuth(global, {
          hasWebAuthTokenPasswordRequired: true,
        });
      }

      setGlobal(global);
      break;
    case 'authorizationStateWaitQrCode':
      global = updateAuth(global, {
        isLoadingQrCode: false,
        qrCode: update.qrCode,
      });
      setGlobal(global);
      break;
    case 'authorizationStateReady': {
      if (wasAuthReady) {
        break;
      }

      void forceWebsync(true);

      global = updateAuth(global, {
        isLoggingOut: false,
      });
      Object.values(global.byTabId).forEach(({ id: tabId }) => {
        global = updateTabState(global, {
          inactiveReason: undefined,
        }, tabId);
      });
      setGlobal(global);

      break;
    }
  }
}

function onUpdateAuthorizationError<T extends GlobalState>(global: T, update: ApiUpdateAuthorizationError) {
  if (update.errorCode === 'PASSKEY_CREDENTIAL_NOT_FOUND') {
    getActions().showNotification({
      message: update.errorKey,
      tabId: getCurrentTabId(),
    });
    return;
  }

  global = updateAuth(global, {
    errorKey: update.errorKey,
  });
  setGlobal(global);
}

function onUpdateConnectionState<T extends GlobalState>(
  global: T, actions: RequiredGlobalActions, update: ApiUpdateConnectionState,
) {
  const { connectionState } = update;

  const tabState = selectTabState(global, getCurrentTabId());
  if (connectionState === 'connectionStateReady' && tabState.isMasterTab && tabState.multitabNextAction) {
    // @ts-ignore
    actions[tabState.multitabNextAction.action](tabState.multitabNextAction.payload);
    actions.clearMultitabNextAction({ tabId: tabState.id });
  }

  if (connectionState === global.connectionState) {
    return;
  }

  global = {
    ...global,
    connectionState,
  };
  setGlobal(global);
}

function onUpdateCurrentUser<T extends GlobalState>(global: T, update: ApiUpdateCurrentUser) {
  const { currentUser, currentUserFullInfo } = update;

  global = {
    ...updateUser(global, currentUser.id, currentUser),
    currentUserId: currentUser.id,
  };
  global = updateUserFullInfo(global, currentUser.id, currentUserFullInfo);
  setGlobal(global);

  updateSessionUserId(currentUser.id);
}
