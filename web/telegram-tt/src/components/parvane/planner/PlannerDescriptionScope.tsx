import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerDescriptionScope as Scope } from './plannerSeriesEdit';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Checkbox from '../../ui/Checkbox';

import styles from './Planner.module.scss';

type OwnProps = {
  scope: Scope;
  // Отделённый день со своим описанием: «для всех» перенесёт описание в ряд — сначала вопрос
  shouldConfirmAll?: boolean;
  onChange: (scope: Scope) => void;
};

// Галочка у описания повторяющейся записи: описание всех повторов либо только этого дня
const PlannerDescriptionScope = ({ scope, shouldConfirmAll, onChange }: OwnProps) => {
  const lang = useLang();

  const [isAsking, setIsAsking] = useState(false);

  const handleCheck = useLastCallback((isChecked: boolean) => {
    if (isChecked && shouldConfirmAll) {
      setIsAsking(true);
      return;
    }
    setIsAsking(false);
    onChange(isChecked ? 'all' : 'one');
  });

  const handleConfirm = useLastCallback(() => {
    setIsAsking(false);
    onChange('all');
  });

  const handleCancel = useLastCallback(() => {
    setIsAsking(false);
  });

  return (
    <div className={styles.descriptionScope} data-description-scope={scope}>
      <Checkbox label={lang('PlannerDescriptionScope')} checked={scope === 'all'} onCheck={handleCheck} />
      {isAsking && (
        <div className={styles.seriesPrompt} role="group" data-description-share>
          <p className={styles.seriesTitle}>{lang('PlannerDescriptionShareTitle')}</p>
          <button type="button" className={buildClassName(styles.btn, styles.btnWide)} onClick={handleConfirm}>
            {lang('PlannerDescriptionShare')}
          </button>
          <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={handleCancel}>
            {lang('Cancel')}
          </button>
        </div>
      )}
    </div>
  );
};

export default memo(PlannerDescriptionScope);
