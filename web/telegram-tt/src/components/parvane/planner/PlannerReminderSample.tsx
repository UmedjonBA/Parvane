import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDurationFull } from './plannerFormat';
import { formatPlainName } from './plannerLinks';
import { getReminders } from './plannerReminders';

import useLang from '../../../hooks/useLang';

import kit from '../notes/PvKit.module.scss';
import styles from './PlannerMore.module.scss';

type OwnProps = {
  state: PlannerState;
};

const MINUTE_MS = 60 * 1000;
// Ближайшее напоминание берётся в пределах месяца; нет — образец с выдуманной записью
const LOOK_AHEAD_MS = 30 * 24 * 60 * MINUTE_MS;
const SAMPLE_MINUTES = 15;

// «Так выглядит напоминание» в настройках «Плана» (доска `RpPlan`): ближайшее настоящее напоминание либо образец —
// строка приложения, «Название — через N минут», время и группа, кнопки уведомления (только показ)
const PlannerReminderSample = ({ state }: OwnProps) => {
  const lang = useLang();

  const sample = useMemo(() => {
    const now = Date.now();
    const next = getReminders(state, now, now + LOOK_AHEAD_MS)[0];
    if (!next) {
      return {
        name: lang('PlannerReminderSampleName'),
        minutes: SAMPLE_MINUTES,
        details: lang('PlannerReminderSampleDetails'),
      };
    }
    const id = next.key.split('@')[0];
    const event = next.kind === 'event' ? state.events.find((item) => item.id === id) : undefined;
    const task = next.kind === 'task' ? state.tasks.find((item) => item.id === id) : undefined;
    const group = event?.project || task?.project;
    const time = event && !event.isAllDay ? `${event.start}–${event.end}` : next.start;
    return {
      name: formatPlainName(next.title),
      minutes: Math.round((next.startsAt - next.at) / MINUTE_MS),
      details: [time, group].filter(Boolean).join(' · '),
    };
  }, [state, lang]);

  return (
    <div className={buildClassName(kit.card, styles.reminderSample)} data-reminder-sample aria-hidden>
      <span className={styles.reminderApp}>{lang('PlannerReminderSampleApp')}</span>
      <span className={styles.reminderTitle}>
        {sample.minutes
          ? lang('PlannerReminderSampleIn', { name: sample.name, time: formatDurationFull(lang, sample.minutes) })
          : sample.name}
      </span>
      {sample.details && <span className={styles.reminderDetails}>{sample.details}</span>}
      <span className={kit.chips}>
        <span className={kit.chip}>{lang('PlannerReminderSampleDone')}</span>
        <span className={kit.chip}>{lang('PlannerReminderSampleSnooze')}</span>
        <span className={kit.chip}>{lang('PlannerReminderSampleOpen')}</span>
      </span>
    </div>
  );
};

export default memo(PlannerReminderSample);
