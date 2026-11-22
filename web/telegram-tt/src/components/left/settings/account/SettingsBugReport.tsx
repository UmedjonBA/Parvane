import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { BugReportArea, BugReportInput } from './bugReport';

import buildClassName from '../../../../util/buildClassName';
import { readStoredColorScheme } from '../../../../util/colorScheme';
import { PARVANE_BUG_REPORT_ADDRESS } from '../../../../util/parvaneDiag';
import { MODULE_TITLE_KEYS } from '../../../main/parvaneModuleNav';
import { getProfileServer } from '../profile/profileFormat';
import {
  BUG_REPORT_AREAS, captureWindow, describeBugReportEnvironment, saveBugReport, sendBugReport,
} from './bugReport';

import useAppLayout from '../../../../hooks/useAppLayout';
import useFlag from '../../../../hooks/useFlag';
import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import { SCHEME_NAMES } from '../../../common/ColorSchemePicker';
import ProfileSwitchRow from '../profile/ProfileSwitchRow';

import kit from '../../../parvane/notes/PvKit.module.scss';
import profile from '../profile/Profile.module.scss';
import styles from './Account.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

const DESCRIPTION_MAX_LENGTH = 2000;

const AREA_KEYS = {
  chats: MODULE_TITLE_KEYS.chats,
  planner: MODULE_TITLE_KEYS.plan,
  health: MODULE_TITLE_KEYS.health,
  notes: MODULE_TITLE_KEYS.notes,
  files: MODULE_TITLE_KEYS.files,
  music: MODULE_TITLE_KEYS.music,
  other: 'ParvaneBugAreaOther',
} as const satisfies Record<BugReportArea, string>;

// Parvane (доски `XpProfile`, `ZdProfileY`): «Сообщить об ошибке» — кому уйдёт отчёт, «Что случилось» и «Что делали
// перед этим», «Где» (чипы модулей), «Что приложим»: журнал приложения за последний час (без текста сообщений и
// ключей), снимок окна (кадр вкладки через выбор экрана браузера), версия и система, «Посмотреть, что уйдёт».
// «Отправить отчёт» — сообщением с вложением на адрес отчётов сервера (`bugReport.ts`), «Сохранить в файл» — тот же
// JSON в загрузки. На компьютере — две колонки: форма слева, «Что приложим» справа
const SettingsBugReport = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const { isDesktop } = useAppLayout();
  const [area, setArea] = useState<BugReportArea>('chats');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [isLogAttached, setIsLogAttached] = useState(true);
  const [isShotAttached, setIsShotAttached] = useState(false);
  const [isPreviewShown, showPreview, hidePreview] = useFlag();
  const [isSending, setIsSending] = useState(false);

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (isActive) return;
    hidePreview();
  }, [isActive, hidePreview]);

  const scheme = SCHEME_NAMES[readStoredColorScheme()];
  const text = description.trim();
  const server = getProfileServer();
  const recipient = PARVANE_BUG_REPORT_ADDRESS.includes('@') || !server
    ? PARVANE_BUG_REPORT_ADDRESS : `${PARVANE_BUG_REPORT_ADDRESS}@${server}`;

  const buildInput = (): BugReportInput => ({
    description: text, steps: steps.trim(), area, withLog: isLogAttached, scheme,
  });

  const handleArea = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setArea(e.currentTarget.dataset.area as BugReportArea);
  });

  const handleSend = useLastCallback(async () => {
    if (!text || isSending) return;
    setIsSending(true);
    const screenshot = isShotAttached ? await captureWindow() : undefined;
    const result = await sendBugReport({ ...buildInput(), screenshot });
    setIsSending(false);
    if (result === 'sent') {
      showNotification({ message: lang('ParvaneBugReportSent') });
      setDescription('');
      setSteps('');
      onReset();
      return;
    }
    showNotification({
      message: lang(result === 'no-address' ? 'ParvaneBugReportNoAddress' : 'ParvaneBugReportFailed'),
    });
  });

  const handleSave = useLastCallback(() => {
    if (!text) return;
    void saveBugReport(buildInput());
  });

  const environment = describeBugReportEnvironment(scheme);

  function renderButtons() {
    return (
      <div className={styles.buttonsRow}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, !isDesktop && kit.btnWide)}
          disabled={!text || isSending}
          data-bug-send
          onClick={handleSend}
        >
          {lang(isSending ? 'ParvaneBugReportSending' : 'ParvaneBugSend')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.btn, !isDesktop && kit.btnWide)}
          disabled={!text}
          data-bug-save
          onClick={handleSave}
        >
          {lang('ParvaneBugSaveFile')}
        </button>
      </div>
    );
  }

  const form = (
    <div className={styles.screenColumn}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="parvane-bug-text">{lang('ParvaneBugWhat')}</label>
        <textarea
          id="parvane-bug-text"
          className={buildClassName(kit.textarea, styles.area)}
          placeholder={lang('ParvaneBugReportPlaceholder')}
          maxLength={DESCRIPTION_MAX_LENGTH}
          value={description}
          data-bug-text
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="parvane-bug-steps">{lang('ParvaneBugSteps')}</label>
        <textarea
          id="parvane-bug-steps"
          className={buildClassName(kit.textarea, styles.area)}
          placeholder={lang('ParvaneBugStepsPlaceholder')}
          maxLength={DESCRIPTION_MAX_LENGTH}
          value={steps}
          data-bug-steps
          onChange={(e) => setSteps(e.currentTarget.value)}
        />
      </div>
      <div className={styles.field}>
        <p className={buildClassName(styles.label, styles.labelCaps)}>{lang('ParvaneBugWhere')}</p>
        <div className={styles.chips} role="group" aria-label={lang('ParvaneBugWhere')}>
          {BUG_REPORT_AREAS.map((item) => (
            <button
              key={item}
              type="button"
              className={buildClassName(kit.chip, area === item && kit.chipOn)}
              aria-pressed={area === item}
              data-area={item}
              onClick={handleArea}
            >
              {lang(AREA_KEYS[item])}
            </button>
          ))}
        </div>
      </div>
      {isDesktop && renderButtons()}
    </div>
  );

  const attachments = (
    <div className={styles.screenColumn}>
      <p className={buildClassName(styles.label, styles.labelCaps)}>{lang('ParvaneBugAttach')}</p>
      <div className={profile.group}>
        <ProfileSwitchRow
          title={lang('ParvaneBugAttachLog')}
          hint={lang('ParvaneBugAttachLogHint')}
          isOn={isLogAttached}
          onChange={setIsLogAttached}
          data-bug-log
        />
        <ProfileSwitchRow
          title={lang('ParvaneBugAttachShot')}
          hint={lang('ParvaneBugAttachShotHint')}
          isOn={isShotAttached}
          onChange={setIsShotAttached}
          data-bug-shot
        />
        <div className={profile.setRow} data-bug-environment>
          <span className={styles.envTitle}>{lang('ParvaneBugEnvironment')}</span>
          <span className={buildClassName(profile.setValue, styles.envValue)}>{environment}</span>
        </div>
        <button
          type="button"
          className={buildClassName(profile.setRow, profile.setRowAction)}
          aria-expanded={isPreviewShown}
          data-bug-preview
          onClick={isPreviewShown ? hidePreview : showPreview}
        >
          <span className={profile.setTitle}>{lang('ParvaneBugWhatIsSent')}</span>
          <span className={buildClassName(profile.setValue, profile.setValueWord)}>{lang('ParvaneBugShow')}</span>
        </button>
      </div>
      {isPreviewShown && (
        <pre className={styles.preview}>
          {[
            environment,
            lang(isLogAttached ? 'ParvaneBugSentWithLog' : 'ParvaneBugSentNoLog'),
            isShotAttached ? lang('ParvaneBugSentShot') : undefined,
          ].filter(Boolean).join('\n')}
        </pre>
      )}
      <p className={profile.hint}>{lang('ParvaneBugReportAbout')}</p>
    </div>
  );

  return (
    <div
      className={buildClassName('settings-content custom-scroll', profile.screen, styles.screen)}
      data-bug-report
      data-settings-page="bug"
    >
      <p className={profile.hint} data-bug-recipient>{lang('ParvaneBugRecipient', { address: recipient })}</p>
      <div className={buildClassName(isDesktop && styles.twoColumns)}>
        {form}
        {attachments}
      </div>
      {!isDesktop && renderButtons()}
    </div>
  );
};

export default memo(SettingsBugReport);
