import type { FC } from '../../../lib/teact/teact';
import {
  memo, useCallback,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';
import type { TimeFormat } from '../../../types';
import type { IRadioOption } from '../../ui/RadioGroup';
import { SettingsScreens } from '../../../types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import {
  IS_ANDROID, IS_IOS, IS_MAC_OS,
} from '../../../util/browser/windowEnvironment';

import useAppLayout from '../../../hooks/useAppLayout';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';

import Island, { IslandTitle } from '../../gili/layout/Island';
import ListItem from '../../ui/ListItem';
import RadioGroup from '../../ui/RadioGroup';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps =
  Pick<SharedSettings, (
    'messageSendKeyCombo' |
    'timeFormat'
  )>;

const SettingsGeneral: FC<OwnProps & StateProps> = ({
  isActive,
  messageSendKeyCombo,
  timeFormat,
  onReset,
}) => {
  const {
    setSharedSettingOption, openSettingsScreen,
  } = getActions();

  const lang = useLang();

  const { isMobile } = useAppLayout();
  const isMobileDevice = isMobile && (IS_IOS || IS_ANDROID);

  const timeFormatOptions: IRadioOption[] = [{
    label: lang('SettingsTimeFormat12'),
    value: '12h',
  }, {
    label: lang('SettingsTimeFormat24'),
    value: '24h',
  }];

  const keyboardSendOptions = !isMobileDevice ? [
    { value: 'enter', label: lang('SettingsSendEnter'), subLabel: lang('SettingsSendEnterDescription') },
    {
      value: 'ctrl-enter',
      label: lang(IS_MAC_OS || IS_IOS ? 'SettingsSendCmdenter' : 'SettingsSendCtrlenter'),
      subLabel: lang('SettingsSendPlusEnterDescription'),
    },
  ] : undefined;

  const handleTimeFormatChange = useCallback((newTimeFormat: string) => {
    setSharedSettingOption({ timeFormat: newTimeFormat as TimeFormat });
    setSharedSettingOption({ wasTimeFormatSetManually: true });
  }, []);

  const handleMessageSendComboChange = useCallback((newCombo: string) => {
    setSharedSettingOption({ messageSendKeyCombo: newCombo as SharedSettings['messageSendKeyCombo'] });
  }, []);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  return (
    <div className="settings-content custom-scroll" data-settings-general>
      <Island>
        <ListItem icon="folder" narrow onClick={() => openSettingsScreen({ screen: SettingsScreens.Folders })}>
          {lang('Filters')}
        </ListItem>
        <ListItem icon="stickers" narrow onClick={() => openSettingsScreen({ screen: SettingsScreens.Stickers })}>
          {lang('MenuStickers')}
        </ListItem>
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('SettingsTimeFormat')}</IslandTitle>
      <Island>
        <RadioGroup
          name="timeformat"
          options={timeFormatOptions}
          selected={timeFormat}
          onChange={handleTimeFormatChange}
        />
      </Island>

      {keyboardSendOptions && (
        <>
          <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('SettingsKeyboard')}</IslandTitle>
          <Island>
            <RadioGroup
              name="keyboard-send-settings"
              options={keyboardSendOptions}
              onChange={handleMessageSendComboChange}
              selected={messageSendKeyCombo}
            />
          </Island>
        </>
      )}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { messageSendKeyCombo, timeFormat } = selectSharedSettings(global);

    return { messageSendKeyCombo, timeFormat };
  },
)(SettingsGeneral));
