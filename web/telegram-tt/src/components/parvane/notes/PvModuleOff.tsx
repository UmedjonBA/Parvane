import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { MODULE_ICONS, MODULE_TITLE_KEYS } from '../../main/parvaneModuleNav';

import useLang from '../../../hooks/useLang';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSheet from './PvSheet';

import kit from './PvKit.module.scss';
import styles from './PvModuleOff.module.scss';

const TEXT_KEYS = {
  plan: { body: 'ModuleOffBodyPlan', enable: 'ModuleOffEnablePlan' },
  notes: { body: 'ModuleOffBodyNotes', enable: 'ModuleOffEnableNotes' },
  music: { body: 'ModuleOffBodyMusic', enable: 'ModuleOffEnableMusic' },
  files: { body: 'ModuleOffBodyFiles', enable: 'ModuleOffEnableFiles' },
} as const;

type OwnProps = {
  isOpen: boolean;
  module: keyof typeof TEXT_KEYS;
  // Что случится после включения: «Трек откроется после включения»
  hint: string;
  onEnable: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

// Parvane (spec 041 E6, доска `PhStates`): лист «Модуль выключен» — карточка в чате ведёт в модуль, выключенный
// на этом устройстве. «Включить» возвращает модуль в навигацию и выполняет то, на что нажали
const PvModuleOff = ({
  isOpen, module, hint, onEnable, onClose,
}: OwnProps) => {
  const lang = useLang();
  const keys = TEXT_KEYS[module];

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('ModuleOffTitle', { module: lang(MODULE_TITLE_KEYS[module]) })}
      onClose={onClose}
      onEnter={onEnable}
    >
      <div className={styles.root} data-module-off={module}>
        <div className={styles.what}>
          <span className={styles.tile}><ParvaneIcon name={MODULE_ICONS[module]} /></span>
          <span className={kit.muted}>{hint}</span>
        </div>
        <p className={styles.text}>{lang(keys.body)}</p>
        <button type="button" className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)} onClick={onEnable}>
          {lang(keys.enable)}
        </button>
        <button type="button" className={buildClassName(kit.btn, kit.btnGhost, kit.btnWide)} onClick={onClose}>
          {lang('ModuleOffNotNow')}
        </button>
        <p className={buildClassName(styles.text, styles.note)}>{lang('ModuleOffSame')}</p>
      </div>
    </PvSheet>
  );
};

export default memo(PvModuleOff);
