import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { BugReportArea } from './bugReport';

import buildClassName from '../../../../util/buildClassName';
import { readStoredColorScheme } from '../../../../util/colorScheme';
import { MODULE_TITLE_KEYS } from '../../../main/parvaneModuleNav';
import { BUG_REPORT_AREAS, describeBugReportEnvironment, sendBugReport } from './bugReport';

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

// Parvane (spec 041, доска `XpProfile`): «Сообщить об ошибке» экраном — где (чипы модулей), что пошло не так,
// «Приложить журнал приложения» (без текста сообщений и записей), «Что будет отправлено · посмотреть» и «Отправить
// администратору сервера». Отчёт уходит сообщением с вложением на адрес отчётов сервера (`bugReport.ts`)
const SettingsBugReport = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [area, setArea] = useState<BugReportArea>('chats');
  const [description, setDescription] = useState('');
  const [isLogAttached, setIsLogAttached] = useState(true);
  const [isPreviewShown, showPreview, hidePreview] = useFlag();
  const [isSending, setIsSending] = useState(false);

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (isActive) return;
    hidePreview();
  }, [isActive, hidePreview]);

  const scheme = SCHEME_NAMES[readStoredColorScheme()];
  const text = description.trim();

  const handleArea = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setArea(e.currentTarget.dataset.area as BugReportArea);
  });

  const handleSend = useLastCallback(async () => {
    if (!text || isSending) return;
    setIsSending(true);
    const result = await sendBugReport({
      description: text, area, withLog: isLogAttached, scheme,
    });
    setIsSending(false);
    if (result === 'sent') {
      showNotification({ message: lang('ParvaneBugReportSent') });
      setDescription('');
      onReset();
      return;
    }
    showNotification({
      message: lang(result === 'no-address' ? 'ParvaneBugReportNoAddress' : 'ParvaneBugReportFailed'),
    });
  });

  return (
    <div
      className={buildClassName('settings-content custom-scroll', profile.screen, styles.screen)}
      data-bug-report
    >
      <div className={styles.field}>
        <p className={styles.label}>{lang('ParvaneBugWhere')}</p>
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
      <div className={styles.field}>
        <label className={styles.label} htmlFor="parvane-bug-text">{lang('ParvaneBugWhat')}</label>
        <textarea
          id="parvane-bug-text"
          className={kit.textarea}
          placeholder={lang('ParvaneBugReportPlaceholder')}
          maxLength={DESCRIPTION_MAX_LENGTH}
          value={description}
          data-bug-text
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </div>
      <div className={profile.group}>
        <ProfileSwitchRow
          title={lang('ParvaneBugAttachLog')}
          hint={lang('ParvaneBugAttachLogHint')}
          isOn={isLogAttached}
          onChange={setIsLogAttached}
          data-bug-log
        />
        <button
          type="button"
          className={buildClassName(profile.setRow, profile.setRowAction)}
          aria-expanded={isPreviewShown}
          data-bug-preview
          onClick={isPreviewShown ? hidePreview : showPreview}
        >
          <span className={profile.setTitle}>{lang('ParvaneBugWhatIsSent')}</span>
          <span className={profile.setValue}>{lang('ParvaneBugShow')}</span>
        </button>
      </div>
      {isPreviewShown && (
        <pre className={styles.preview}>
          {[
            describeBugReportEnvironment(scheme),
            lang(isLogAttached ? 'ParvaneBugSentWithLog' : 'ParvaneBugSentNoLog'),
          ].join('\n')}
        </pre>
      )}
      <p className={profile.hint}>{lang('ParvaneBugReportAbout')}</p>
      <button
        type="button"
        className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
        disabled={!text || isSending}
        data-bug-send
        onClick={handleSend}
      >
        {lang(isSending ? 'ParvaneBugReportSending' : 'ParvaneBugSend')}
      </button>
    </div>
  );
};

export default memo(SettingsBugReport);
