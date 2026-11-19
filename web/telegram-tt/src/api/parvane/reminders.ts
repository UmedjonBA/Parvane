// Напоминания «Плана» (этап 4 плана 15 окт 2026). Открытое приложение раз в `TICK_MS` и при изменении «Плана»:
// (1) отдаёт серверу моменты ближайших напоминаний (`push.alarm.set`) и кладёт их тексты для service worker — так
// закрытое приложение будит сервер, а показывает service worker; (2) наступившее показывает само и пишет одним
// сообщением в «Избранное». Два открытых устройства не пишут дважды: перед записью — случайная пауза и свежий
// синк «Плана», затем отметка «напомнено» (`reminded`) в его данных; отмеченное другим устройством только звенит
// (свежее — в пределах `FRESH_MS`, если на этом устройстве ещё не показано).
import type { PlannerReminder } from '../../components/parvane/planner/plannerReminders';
import type { WorkerReminder } from '../../util/reminderStore';

import { NOTIFY_SNOOZE_MS } from '../../util/systemNotify';

type Deps = {
  stateJson: () => string | undefined;
  isReady: () => boolean;
  apply: (changes: unknown[]) => void;
  flush: () => Promise<void>;
  syncNow: () => Promise<void>;
  sendToSelf: (text: string) => Promise<unknown>;
  ring: (reminder: PlannerReminder) => void;
  setAlarms: (atMs: number[]) => Promise<unknown>;
  saveForWorker: (items: WorkerReminder[]) => Promise<void>;
  markShown: (key: string) => Promise<void>;
  // Уже показано на этом устройстве, в том числе до перезагрузки вкладки
  isShown: (key: string) => Promise<boolean>;
  // Текст напоминания можно хранить для service worker (нет PIN хранилища)
  canKeepText: () => Promise<boolean>;
  formatMessage: (reminder: PlannerReminder) => string;
  log: (text: string) => void;
  // «Через 10 мин» в уведомлении (spec 041 F2): отложенные напоминания этого устройства переживают перезагрузку
  ringSnoozed: (snooze: WorkerReminder) => void;
  loadSnoozes: () => Promise<WorkerReminder[]>;
  saveSnoozes: (items: WorkerReminder[]) => Promise<void>;
};

const TICK_MS = 30 * 1000;
// Изменение «Плана» пересчитывает напоминания не чаще
const CHANGE_DELAY_MS = 1500;
// Пауза перед записью в «Избранное»: устройства расходятся во времени, второе успевает увидеть отметку первого
const WRITE_JITTER_MS = 12 * 1000;
// Звенит только свежее: пропущенное (приложение было закрыто) лишь дописывается в «Избранное»
const FRESH_MS = 2 * 60 * 1000;
// Ключ отложенного: `<ключ напоминания>~<момент>` — у каждого откладывания своя отметка «показано»
const SNOOZE_SEPARATOR = '~';
// Предел `push.alarm.set` (`SetAlarmsRequest.at_ms`)
const MAX_ALARMS = 64;

type ReminderModule = typeof import('../../components/parvane/planner/plannerReminders');

export function createReminderScheduler(deps: Deps) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let module: Promise<ReminderModule> | undefined;
  let lastAlarms = '';
  let isTicking = false;
  // Наступившие, которые это устройство уже обработало: позвонило / взялось записать в «Избранное»
  const rung = new Set<string>();
  const handled = new Set<string>();
  let snoozes: WorkerReminder[] | undefined;

  function loadModule() {
    module ??= import('../../components/parvane/planner/plannerReminders');
    return module;
  }

  async function read() {
    const json = deps.stateJson();
    if (!json || !deps.isReady()) return undefined;
    const { readReminders } = await loadModule();
    return readReminders(json, Date.now(), FRESH_MS);
  }

  async function readSnoozes() {
    snoozes ??= await deps.loadSnoozes().catch(() => []);
    return snoozes;
  }

  async function writeSnoozes(items: WorkerReminder[]) {
    snoozes = items;
    await deps.saveSnoozes(items).catch((e: unknown) => deps.log(`напоминания: отложенные не сохранены: ${String(e)}`));
  }

  /** «Через 10 мин»: напоминание звенит снова через `NOTIFY_SNOOZE_MS` — и у закрытого приложения тоже. */
  async function snooze(key: string, title?: string) {
    const base = key.split(SNOOZE_SEPARATOR)[0];
    const at = Date.now() + NOTIFY_SNOOZE_MS;
    const others = (await readSnoozes()).filter((item) => item.key.split(SNOOZE_SEPARATOR)[0] !== base);
    await writeSnoozes([...others, { key: `${base}${SNOOZE_SEPARATOR}${at}`, at, title }]);
    lastAlarms = '';
    await tick();
  }

  async function ringSnoozes() {
    const list = await readSnoozes();
    const now = Date.now();
    const due = list.filter(({ at }) => at <= now);
    if (!due.length) return;
    await writeSnoozes(list.filter(({ at }) => at > now));
    for (const item of due) {
      if (await deps.isShown(item.key).catch(() => false)) continue;
      deps.ringSnoozed(item);
      void deps.markShown(item.key).catch(() => undefined);
    }
  }

  async function publishUpcoming(upcoming: PlannerReminder[]) {
    const pending = await readSnoozes();
    const items = [...upcoming.map(({ key, at, title }) => ({ key, at, title })), ...pending];
    const signature = items.map(({ key, at, title }) => `${key}:${at}:${title}`).join('|');
    if (signature === lastAlarms) return;
    lastAlarms = signature;
    const keepText = await deps.canKeepText();
    await deps.saveForWorker(items.map(({ key, at, title }) => ({ key, at, title: keepText ? title : undefined })))
      .catch((e: unknown) => deps.log(`напоминания: для service worker не сохранены: ${String(e)}`));
    // Сервер принимает не больше `MAX_ALARMS` моментов: ближайшие
    const moments = [...new Set(items.map(({ at }) => at))].sort((a, b) => a - b).slice(0, MAX_ALARMS);
    await deps.setAlarms(moments)
      .then(() => deps.log(`напоминания: будильник на сервере (${moments.length})`))
      .catch((e: unknown) => {
        lastAlarms = '';
        deps.log(`напоминания: будильник на сервере не поставлен: ${String(e)}`);
      });
  }

  async function writeDue(reminder: PlannerReminder) {
    await new Promise((resolve) => {
      setTimeout(resolve, Math.random() * WRITE_JITTER_MS);
    });
    await deps.syncNow().catch(() => undefined);
    const fresh = await read();
    // Другое устройство уже отметило — не пишем
    if (!fresh || !fresh.due.some(({ key }) => key === reminder.key)) return;
    deps.apply([{ reminded: { id: reminder.key } }]);
    await deps.flush().catch(() => undefined);
    await deps.sendToSelf(deps.formatMessage(reminder));
    deps.log(`напоминания: записано в «Избранное» (${reminder.kind})`);
  }

  async function tick() {
    if (isTicking) return;
    isTicking = true;
    try {
      const result = await read();
      if (!result) return;
      await ringSnoozes();
      await publishUpcoming(result.upcoming);
      // Звенит свежее, даже если другое устройство уже отметило его «напомнено» (его такт мог прийти раньше)
      for (const reminder of result.fresh) {
        if (rung.has(reminder.key)) continue;
        rung.add(reminder.key);
        if (await deps.isShown(reminder.key).catch(() => false)) continue;
        deps.ring(reminder);
        void deps.markShown(reminder.key).catch(() => undefined);
      }
      for (const reminder of result.due) {
        if (handled.has(reminder.key)) continue;
        handled.add(reminder.key);
        void writeDue(reminder).catch((e: unknown) => {
          handled.delete(reminder.key);
          deps.log(`напоминания: в «Избранное» не записано: ${String(e)}`);
        });
      }
    } catch (e) {
      deps.log(`напоминания: расчёт не удался: ${String(e)}`);
    } finally {
      isTicking = false;
    }
  }

  function onPlannerChanged() {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      void tick();
    }, CHANGE_DELAY_MS);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => void tick(), TICK_MS);
    onPlannerChanged();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (changeTimer) clearTimeout(changeTimer);
    timer = undefined;
    changeTimer = undefined;
    lastAlarms = '';
    rung.clear();
    handled.clear();
    snoozes = undefined;
  }

  return {
    start, stop, onPlannerChanged, snooze,
  };
}
