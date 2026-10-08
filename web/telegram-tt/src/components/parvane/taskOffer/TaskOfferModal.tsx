import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import { callApi } from '../../../api/gramjs';
import { validateTask } from '../planner/plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import InputText from '../../ui/InputText';
import Modal from '../../ui/Modal';
import TextArea from '../../ui/TextArea';
import PlannerField from '../planner/PlannerField';

import styles from './TaskOfferModal.module.scss';

type OwnProps = {
  isOpen: boolean;
  chatId: string;
  onClose: NoneToVoidFunction;
};

const NAME_MAX_LENGTH = 200;
const MAX_STEPS = 100;
const STEP_MAX_LENGTH = 160;

const TASK_ERROR_KEYS = {
  name: 'PlannerErrorName',
  minutes: 'PlannerErrorMinutes',
  startNeedsDayAndMinutes: 'PlannerErrorStartNeeds',
  pastMidnight: 'PlannerErrorPastMidnight',
  dayAfterDue: 'PlannerErrorDayAfterDue',
} as const;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (spec 011, US3): форма задания в чат — поля как у задачи планировщика
const TaskOfferModal = ({ isOpen, chatId, onClose }: OwnProps) => {
  const lang = useLang();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [day, setDay] = useState('');
  const [start, setStart] = useState('');
  const [minutes, setMinutes] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string>();
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    if (isOpen) return;
    setName('');
    setDescription('');
    setSteps('');
    setDay('');
    setStart('');
    setMinutes('');
    setDue('');
    setError(undefined);
  }, [isOpen]);

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const handleDescriptionChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.currentTarget.value);
  });

  const handleStepsChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSteps(e.currentTarget.value);
  });

  const handleSubmit = useLastCallback(async () => {
    const task = {
      name: name.trim(),
      minutes: minutes === '' ? undefined : Number(minutes),
      day: day || undefined,
      start: start || undefined,
      due: due || undefined,
    };
    const problem = validateTask(task);
    if (problem) {
      setError(lang(TASK_ERROR_KEYS[problem]));
      return;
    }
    const chat = getGlobal().chats.byId[chatId];
    if (!chat) return;
    setIsSending(true);
    try {
      await callParvane('parvaneSendTaskOffer', {
        chat,
        offer: {
          ...task,
          description: description.trim(),
          steps: steps.split('\n')
            .map((step) => step.trim().slice(0, STEP_MAX_LENGTH))
            .filter(Boolean)
            .slice(0, MAX_STEPS),
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSending(false);
    }
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      onEnter={handleSubmit}
      title={lang('TaskOfferTitle')}
      dialogClassName={styles.root}
      isSlim
      hasCloseButton
    >
      <div className={styles.form}>
        <InputText
          id="task-offer-name"
          label={lang('PlannerFieldTaskName')}
          value={name}
          maxLength={NAME_MAX_LENGTH}
          autoFocus
          onChange={handleNameChange}
        />
        <div className={styles.fields}>
          <PlannerField label={lang('PlannerFieldWorkDate')} type="date" value={day} onInput={setDay} />
          <PlannerField label={lang('PlannerFieldStart')} type="time" value={start} onInput={setStart} />
          <PlannerField
            label={lang('PlannerFieldMinutes')}
            type="number"
            value={minutes}
            min={5}
            max={1440}
            step={5}
            placeholder={lang('PlannerNoEstimate')}
            onInput={setMinutes}
          />
          <PlannerField label={lang('PlannerFieldDue')} type="date" value={due} onInput={setDue} />
        </div>
        <TextArea
          label={lang('PlannerFieldDescription')}
          value={description}
          onChange={handleDescriptionChange}
          noReplaceNewlines
        />
        <TextArea
          label={lang('TaskOfferSteps')}
          value={steps}
          onChange={handleStepsChange}
          noReplaceNewlines
        />
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <Button size="smaller" disabled={isSending} onClick={handleSubmit}>{lang('TaskOfferSend')}</Button>
          <Button isText size="smaller" onClick={onClose}>{lang('Cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
};

export default memo(TaskOfferModal);
