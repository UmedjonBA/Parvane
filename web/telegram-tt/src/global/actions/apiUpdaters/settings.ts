import type { ActionReturnType } from '../../types';

import { addActionHandler, setGlobal } from '../../index';
import {
  addNotifyException,
} from '../../reducers';

addActionHandler('apiUpdate', (global, actions, update): ActionReturnType => {
  switch (update['@type']) {
    case 'updateChatNotifySettings': {
      const {
        chatId, settings,
      } = update;

      global = addNotifyException(global, chatId, settings);
      setGlobal(global);
      break;
    }
  }

  return undefined;
});
