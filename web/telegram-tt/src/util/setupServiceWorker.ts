import { getActions } from '../global';

import type { NotifyCommand } from './systemNotify';

import { DEBUG, DEBUG_MORE, IS_TEST } from '../config';
// eslint-disable-next-line import-x/default
import serviceWorkerUrl from '../serviceWorker/service.worker.ts?worker&url';
import { IS_ANDROID, IS_IOS, IS_SERVICE_WORKER_SUPPORTED } from './browser/windowEnvironment';
import { notifyClientReady, playNotifySoundDebounced } from './notifications';
import { runNotifyCommand } from './notifyCommands';
import { handleAppShellMessage, requestAppShellPrecache } from './precacheAppShell';

type WorkerAction = {
  type: string;
  payload: Record<string, any>;
};

const IGNORE_WORKER_PATH = '/k/';
const SERVICE_WORKER_OPTIONS: RegistrationOptions = import.meta.env.DEV
  ? { scope: './', type: 'module' }
  : { type: 'module' };

function handleWorkerMessage(e: MessageEvent) {
  const action: WorkerAction = e.data;
  if (DEBUG_MORE) {
    // eslint-disable-next-line no-console
    console.log('[SW] Message from worker', action);
  }
  if (!action.type) return;
  handleAppShellMessage(action.type, action.payload);
  const payload = action.payload;
  switch (action.type) {
    // Нажатие на системное уведомление (spec 041 F2)
    case 'parvaneNotify':
      runNotifyCommand(payload as NotifyCommand);
      navigator.serviceWorker.controller?.postMessage({ type: 'parvaneNotifyDone' });
      break;
    // Service worker спрашивает перед показом push, жива ли страница (иначе покажет уведомление сам)
    case 'parvanePing':
      e.ports[0]?.postMessage(true);
      break;
    case 'playNotificationSound':
      playNotifySoundDebounced(action.payload.id);
      break;
  }
}

function subscribeToWorker() {
  navigator.serviceWorker.removeEventListener('message', handleWorkerMessage);
  navigator.serviceWorker.addEventListener('message', handleWorkerMessage);
  // Notify web worker that client is ready to receive messages
  notifyClientReady();
  requestAppShellPrecache();
}

if (IS_SERVICE_WORKER_SUPPORTED) {
  window.addEventListener('load', async () => {
    try {
      const controller = navigator.serviceWorker.controller;
      if (!controller || controller.scriptURL.includes(IGNORE_WORKER_PATH)) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const ourRegistrations = registrations.filter((r) => !r.scope.includes(IGNORE_WORKER_PATH));
        if (ourRegistrations.length) {
          if (DEBUG) {
            // eslint-disable-next-line no-console
            console.log('[SW] Hard reload detected, re-enabling Service Worker');
          }
          await Promise.all(ourRegistrations.map((r) => r.unregister()));
        }
      }

      // Первый визит: сервис-воркер берёт страницу под управление уже после `ready` — подписаться и тогда
      navigator.serviceWorker.addEventListener('controllerchange', subscribeToWorker);
      await navigator.serviceWorker.register(serviceWorkerUrl, SERVICE_WORKER_OPTIONS);

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[SW] ServiceWorker registered');
      }

      await navigator.serviceWorker.ready;

      // Wait for registration to be available
      await navigator.serviceWorker.getRegistration();

      if (navigator.serviceWorker.controller) {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[SW] ServiceWorker ready');
        }
        subscribeToWorker();
      } else {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.error('[SW] ServiceWorker not available');
        }

        if (!IS_IOS && !IS_ANDROID && !IS_TEST) {
          getActions().showDialog?.({ data: { type: 'error', message: 'SERVICE_WORKER_DISABLED', hasErrorKey: true } });
        }
      }
    } catch (err) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error('[SW] ServiceWorker registration failed: ', err);
      }
    }
  });
  window.addEventListener('focus', async () => {
    await navigator.serviceWorker.ready;
    subscribeToWorker();
  });
}
