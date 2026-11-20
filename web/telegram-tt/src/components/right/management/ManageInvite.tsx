import type { ChangeEvent } from 'react';
import type { FC } from '../../../lib/teact/teact';
import { memo, useCallback, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiExportedInvite } from '../../../api/types';
import { ManagementScreens } from '../../../types';

import { isChatChannel, isChatPublic } from '../../../global/helpers';
import { selectChat, selectTabState } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { formatFullDate, formatTime } from '../../../util/dates/oldDateFormat';
import { getServerTime } from '../../../util/serverTime';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';
import useSyncEffect from '../../../hooks/useSyncEffect';

import CalendarModal from '../../common/CalendarModal';
import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import SwitchField from '../../gili/templates/SwitchField';
import Button from '../../ui/Button';
import InputText from '../../ui/InputText';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './ManageInvite.module.scss';

const DEFAULT_USAGE_LIMITS = [1, 10, 100];
const DEFAULT_EXPIRE_DATE = {
  hour: 3600000,
  day: 86400000,
  week: 604800000,
  month: 2592000000,
};
// Parvane: сроки — как у ссылок «Файлов» (1 / 7 / 30 дней, без срока) плюс час и своя дата
const EXPIRE_OPTIONS = ['hour', 'day', 'week', 'month', 'unlimited', 'custom'] as const;
const USAGE_OPTIONS = ['0', ...DEFAULT_USAGE_LIMITS.map(String), 'custom'];
const DEFAULT_CUSTOM_EXPIRE_DATE = DEFAULT_EXPIRE_DATE.hour;

type OwnProps = {
  chatId: string;
  onClose: NoneToVoidFunction;
  onScreenSelect: (screen: ManagementScreens) => void;
  isActive: boolean;
};

type StateProps = {
  editingInvite?: ApiExportedInvite;
  isPublic: boolean;
  isChannel: boolean;
};

const ManageInvite: FC<OwnProps & StateProps> = ({
  chatId,
  editingInvite,
  isPublic,
  isChannel,
  isActive,
  onClose,
  onScreenSelect,
}) => {
  const { editExportedChatInvite, exportChatInvite } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();
  const [isCalendarOpened, openCalendar, closeCalendar] = useFlag();
  const [isRequestNeeded, setIsRequestNeeded] = useState(false);
  const [title, setTitle] = useState('');
  const [customExpireDate, setCustomExpireDate] = useState<number>(() => Date.now() + DEFAULT_CUSTOM_EXPIRE_DATE);
  const [selectedExpireOption, setSelectedExpireOption] = useState('unlimited');
  const [customUsageLimit, setCustomUsageLimit] = useState<number | undefined>(10);
  const [selectedUsageOption, setSelectedUsageOption] = useState('0');
  const [isSubmitBlocked, setIsSubmitBlocked] = useState(false);

  const effectiveIsRequestNeeded = !isPublic && isRequestNeeded;

  useHistoryBack({
    isActive,
    onBack: onClose,
  });

  useSyncEffect(([oldEditingInvite]) => {
    if (oldEditingInvite === editingInvite) return;
    if (!editingInvite) {
      setTitle('');
      setSelectedExpireOption('unlimited');
      setSelectedUsageOption('0');
      setCustomExpireDate(getServerTime() * 1000 + DEFAULT_CUSTOM_EXPIRE_DATE);
      setCustomUsageLimit(10);
      setIsRequestNeeded(false);
    } else {
      const {
        title: editingTitle, usageLimit, expireDate, isRequestNeeded: editingIsRequestNeeded,
      } = editingInvite;
      if (editingTitle) setTitle(editingTitle);
      if (usageLimit) {
        setSelectedUsageOption(DEFAULT_USAGE_LIMITS.includes(usageLimit) ? usageLimit.toString() : 'custom');
        setCustomUsageLimit(usageLimit);
      }
      if (expireDate) {
        const minSafeDate = getServerTime() + DEFAULT_CUSTOM_EXPIRE_DATE;
        setSelectedExpireOption('custom');
        setCustomExpireDate(Math.max(expireDate, minSafeDate) * 1000);
      }
      if (editingIsRequestNeeded) {
        setIsRequestNeeded(true);
      }
    }
  }, [editingInvite]);

  const handleIsRequestChange = useCallback((isChecked: boolean) => {
    setIsRequestNeeded(isChecked);
  }, []);

  const handleTitleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  }, []);

  const handleCustomUsageLimitChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setCustomUsageLimit(Number.parseInt(e.target.value, 10));
  }, []);

  const handleExpireDateChange = useCallback((date: Date) => {
    setCustomExpireDate(date.getTime());
    closeCalendar();
  }, [closeCalendar]);

  const handleSaveClick = useCallback(() => {
    setIsSubmitBlocked(true);
    const usageLimit = selectedUsageOption === 'custom' ? customUsageLimit : Number(selectedUsageOption);
    let expireDate;
    switch (selectedExpireOption) {
      case 'custom':
        expireDate = getServerTime() + (customExpireDate - Date.now()) / 1000;
        break;
      case 'hour':
      case 'day':
      case 'week':
      case 'month':
        expireDate = getServerTime() + DEFAULT_EXPIRE_DATE[selectedExpireOption] / 1000;
        break;
      case 'unlimited':
        expireDate = 0;
        break;
      default:
        expireDate = undefined;
    }

    if (editingInvite) {
      editExportedChatInvite({
        link: editingInvite.link,
        chatId,
        title,
        isRequestNeeded: effectiveIsRequestNeeded,
        expireDate,
        usageLimit,
      });
    } else {
      exportChatInvite({
        chatId,
        title,
        isRequestNeeded: effectiveIsRequestNeeded,
        expireDate,
        usageLimit,
      });
    }
    onScreenSelect(ManagementScreens.Invites);
  }, [
    chatId, customExpireDate, customUsageLimit, editExportedChatInvite, editingInvite,
    exportChatInvite, effectiveIsRequestNeeded, selectedExpireOption, selectedUsageOption, title, onScreenSelect,
  ]);

  function renderExpireLabel(option: typeof EXPIRE_OPTIONS[number]) {
    switch (option) {
      case 'hour': return oldLang('Hours', 1);
      case 'day': return oldLang('Days', 1);
      case 'week': return oldLang('Days', 7);
      case 'month': return oldLang('Days', 30);
      case 'unlimited': return oldLang('NoLimit');
      default: return oldLang('lng_group_invite_expire_custom');
    }
  }

  return (
    <div className="Management ManageInvite">
      <div className="panel-content custom-scroll">
        {!(isPublic && isChannel) && (
          <>
            <Island>
              <SwitchField
                checked={effectiveIsRequestNeeded}
                onChange={handleIsRequestChange}
                label={oldLang('ApproveNewMembers')}
                // Parvane: «по заявке» задаётся при создании ссылки и потом не меняется (spec 024)
                disabled={isPublic || Boolean(editingInvite)}
              />
            </Island>
            <IslandDescription>
              {isPublic
                ? lang('ApproveNewMembersPublicUnavailable')
                : editingInvite ? lang('ParvaneInviteApprovalFixed') : oldLang('ApproveNewMembersDescription')}
            </IslandDescription>
          </>
        )}
        <Island>
          <InputText
            className="link-name"
            placeholder={oldLang('LinkNameHint')}
            value={title}
            onChange={handleTitleChange}
          />
        </Island>
        <IslandDescription>{oldLang('LinkNameHelp')}</IslandDescription>
        <IslandTitle>{oldLang('LimitByPeriod')}</IslandTitle>
        {/* Parvane (spec 041): срок и лимит — чипами, как у ссылок «Файлов» (доски `PhFilesMore`, `DkFilesDialogs`) */}
        <Island>
          <div
            className={buildClassName(kit.chips, styles.chips)}
            role="radiogroup"
            aria-label={oldLang('LimitByPeriod')}
          >
            {EXPIRE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selectedExpireOption === option}
                className={buildClassName(kit.chip, selectedExpireOption === option && kit.chipOn)}
                data-invite-expire={option}
                onClick={() => setSelectedExpireOption(option)}
              >
                {renderExpireLabel(option)}
              </button>
            ))}
          </div>
          {selectedExpireOption === 'custom' && (
            <Button className="expire-limit" isText onClick={openCalendar}>
              {formatFullDate(oldLang, customExpireDate)}
              {' '}
              {formatTime(oldLang, customExpireDate)}
            </Button>
          )}
        </Island>
        <IslandDescription>{oldLang('TimeLimitHelp')}</IslandDescription>
        {!effectiveIsRequestNeeded && (
          <>
            <IslandTitle>{oldLang('LimitNumberOfUses')}</IslandTitle>
            <Island>
              <div
                className={buildClassName(kit.chips, styles.chips)}
                role="radiogroup"
                aria-label={oldLang('LimitNumberOfUses')}
              >
                {USAGE_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selectedUsageOption === option}
                    className={buildClassName(kit.chip, selectedUsageOption === option && kit.chipOn)}
                    data-invite-usage={option}
                    onClick={() => setSelectedUsageOption(option)}
                  >
                    {option === '0' ? oldLang('NoLimit')
                      : option === 'custom' ? oldLang('lng_group_invite_usage_custom') : option}
                  </button>
                ))}
              </div>
              {selectedUsageOption === 'custom' && (
                <input
                  className={buildClassName(kit.input, styles.usageInput)}
                  type="number"
                  min="1"
                  max="99999"
                  value={customUsageLimit}
                  data-invite-usage-custom
                  onChange={handleCustomUsageLimitChange}
                />
              )}
            </Island>
            <IslandDescription>{oldLang('UsesLimitHelp')}</IslandDescription>
          </>
        )}
        <div className={styles.submit}>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
            disabled={isSubmitBlocked}
            data-invite-submit
            onClick={handleSaveClick}
          >
            {editingInvite ? oldLang('SaveLink') : oldLang('CreateLink')}
          </button>
        </div>
      </div>
      <CalendarModal
        isOpen={isCalendarOpened}
        isFutureMode
        withTimePicker
        onClose={closeCalendar}
        onSubmit={handleExpireDateChange}
        selectedAt={customExpireDate}
        submitButtonLabel={oldLang('Save')}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const { editingInvite } = selectTabState(global).management.byChatId[chatId] || {};
    const chat = selectChat(global, chatId);

    return {
      editingInvite,
      isPublic: Boolean(chat && isChatPublic(chat)),
      isChannel: Boolean(chat && isChatChannel(chat)),
    };
  },
)(ManageInvite));
