import type { ActionReturnType } from '../../types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { addActionHandler } from '../..';
import { updateTabState } from '../../reducers/tabs';

addActionHandler('openFrozenAccountModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  return updateTabState(global, {
    isFrozenAccountModalOpen: true,
  }, tabId);
});

addActionHandler('closeDeleteAccountModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  return updateTabState(global, {
    deleteAccountModal: undefined,
  }, tabId);
});

addActionHandler('openAgeVerificationModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  return updateTabState(global, {
    isAgeVerificationModalOpen: true,
  }, tabId);
});

addActionHandler('closeAgeVerificationModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  return updateTabState(global, {
    isAgeVerificationModalOpen: false,
  }, tabId);
});
