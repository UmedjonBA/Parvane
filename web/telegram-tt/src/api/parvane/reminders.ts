// Напоминания «Плана» (этап 4 плана 15 окт 2026). Открытое приложение раз в `TICK_MS` и при изменении «Плана»:
// (1) отдаёт серверу моменты ближайших напоминаний (`push.alarm.set`) и кладёт их тексты для service worker — так
// закрытое приложение будит сервер, а показывает service worker; (2) наступившее показывает само и пишет одним
// сообщением в «Избранное». Два открытых устройства не пишут дважды: перед записью — случайная пауза и свежий
// синк «Плана», затем отметка «напомнено» (`reminded`) в его данных; отмеченное другим устройством только звенит.
import type { PlannerReminder } from '../../components/parvane/planner/plannerReminders';
import type { WorkerReminder } from '../../util/reminderStore';

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
  // Текст напоминания можно хранить для service worker (нет PIN хранилища)
  canKeepText: () => Promise<boolean>;
  formatMessage: (reminder: PlannerReminder) => string;
  log: (text: string) => void;
};

const TICK_MS = 30 * 1000;
// Изменение «Плана» пересчитывает напоминания не чаще
const CHANGE_DELAY_MS = 1500;
// Пауза перед записью в «Избранное»: устройства расходятся во времени, второе успевает увидеть отметку первого
const WRITE_JITTER_MS = 12 * 1000;
// Звенит только свежее: пропущенное (приложение было закрыто) лишь дописывается в «Избранное»
const FRESH_MS = 2 * 60 * 1000;

type ReminderModule = typeof import('../../components/parvane/planner/plannerReminders');

export function createReminderScheduler(deps: Deps) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let module: Promise<ReminderModule> | undefined;
  let lastAlarms = '';
  let isTicking = false;
  // Наступившие, которые это устройство уже обработало (позвонило и, может быть, записало)
  const handled = new Set<string>();

  function loadModule() {
    module ??= import('../../components/parvane/planner/plannerReminders');
    return module;
  }

  async function read() {
    const json = deps.stateJson();
    if (!json || !deps.isReady()) return undefined;
    const { readReminders } = await loadModule();
    return readReminders(json, Date.now());
  }

  async function publishUpcoming(upcoming: PlannerReminder[]) {
    const signature = upcoming.map(({ key, at, title }) => `${key}:${at}:${title}`).join('|');
    if (signature === lastAlarms) return;
    lastAlarms = signature;
    const keepText = await deps.canKeepText();
    await deps.saveForWorker(upcoming.map(({ key, at, title }) => ({ key, at, title: keepText ? title : undefined })))
      .catch((e: unknown) => deps.log(`напоминания: для service worker не сохранены: ${String(e)}`));
    const moments = [...new Set(upcoming.map(({ at }) => at))];
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
      await publishUpcoming(result.upcoming);
      const now = Date.now();
      for (const reminder of result.due) {
        if (handled.has(reminder.key)) continue;
        handled.add(reminder.key);
        if (now - reminder.at <= FRESH_MS) {
          deps.ring(reminder);
          void deps.markShown(reminder.key).catch(() => undefined);
        }
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
    handled.clear();
  }

  return { start, stop, onPlannerChanged };
}
