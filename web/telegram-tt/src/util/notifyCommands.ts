import { getActions, getGlobal } from '../global';

import type { NotifyCommand } from './systemNotify';

import { callApi } from '../api/gramjs';
import { getIsModuleOn } from './parvaneModules';
import { openPlannerView, setParvaneSection } from './parvaneSection';

// parvane* — методы провайдера вне типизированного Methods
const callParvane = callApi as unknown as (name: string, args?: unknown) => Promise<unknown>;

const COMPOSER_ID = 'editable-message-text';
// Поле ввода появляется после открытия чата: ждать его не дольше
const COMPOSER_WAIT_MS = 3000;
const COMPOSER_POLL_MS = 100;
const MAX_DONE_IDS = 50;

// Команда может прийти дважды (сообщение service worker и его повтор на `clientReady` после показа окна)
const doneIds: string[] = [];

/**
 * Выполнить нажатие на системное уведомление (spec 041 F2; команду присылает service worker,
 * `serviceWorker/pushNotification.ts`). Возвращает, выполнена ли она впервые.
 */
export function runNotifyCommand(command: NotifyCommand) {
  if (command.id) {
    if (doneIds.includes(command.id)) return false;
    doneIds.push(command.id);
    if (doneIds.length > MAX_DONE_IDS) doneIds.shift();
  }
  switch (command.kind) {
    case 'message':
      runMessageCommand(command);
      break;
    case 'call':
      runCallCommand(command);
      break;
    case 'reminder':
      runReminderCommand(command);
      break;
    case 'music':
      runMusicCommand(command);
      break;
    case 'wake':
      setParvaneSection('messenger');
      break;
  }
  return true;
}

function runMessageCommand({ action, chatId, messageId }: NotifyCommand) {
  if (!chatId) {
    setParvaneSection('messenger');
    return;
  }
  const { focusMessage, markChatMessagesRead, openChat } = getActions();
  if (action === 'read') {
    markChatMessagesRead({ id: chatId });
    return;
  }
  setParvaneSection('messenger');
  if (messageId) {
    focusMessage({ chatId, messageId, shouldReplaceHistory: true });
  } else {
    openChat({ id: chatId, shouldReplaceHistory: true });
  }
  if (action === 'reply') focusComposer();
}

function runCallCommand({ action }: NotifyCommand) {
  // Экран звонка поверх приложения уже показан: нажатие на само уведомление только показывает окно
  if (action === 'answer') void callParvane('parvaneAcceptCall');
  if (action === 'decline') void callParvane('parvaneHangUp');
}

function runReminderCommand({ action, reminderKey, reminderTitle }: NotifyCommand) {
  // «План» выключен на этом устройстве: напоминаний нет, нажатие открывает обычный экран
  if (!getIsModuleOn('plan')) return;
  if (action === 'done' && reminderKey) {
    // «План» — отдельная часть сборки: грузится, только когда нужен
    void import('../components/parvane/planner/plannerReminderDone')
      .then(({ markReminderDone }) => markReminderDone(reminderKey, getGlobal().currentUserId));
    return;
  }
  if (action === 'snooze' && reminderKey) {
    void callParvane('parvaneSnoozeReminder', { key: reminderKey, title: reminderTitle });
    return;
  }
  openPlannerView('today');
}

// «Трек скачан на сервер»: «Слушать» играет трек, нажатие на уведомление открывает «Музыку»
function runMusicCommand({ action, trackId }: NotifyCommand) {
  if (!getIsModuleOn('music')) return;
  setParvaneSection('music');
  if (action !== 'listen' || !trackId) return;
  // «Музыка» — отдельная часть сборки: грузится, только когда нужна
  void import('../components/parvane/music/musicPlayer').then(async ({ callMusic, playTracks }) => {
    const tracks = await callMusic('parvaneMusicTracks', { trackIds: [trackId] }).catch(() => undefined);
    if (tracks?.length) playTracks(tracks);
  });
}

function focusComposer() {
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    const composer = document.getElementById(COMPOSER_ID);
    if (composer) composer.focus();
    if (composer || Date.now() - startedAt > COMPOSER_WAIT_MS) window.clearInterval(timer);
  }, COMPOSER_POLL_MS);
}
