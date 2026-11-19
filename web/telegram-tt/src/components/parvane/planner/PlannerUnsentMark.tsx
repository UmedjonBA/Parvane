import { memo } from '../../../lib/teact/teact';

import { getPlannerUnsent } from './plannerStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';

import styles from './PlannerPv.module.scss';

type OwnProps = {
  id: string;
};

// Пометка у записи, правка которой ещё не дошла до сервера (доска `PhStates`): «не отправлено · уйдёт при
// появлении связи». Какие записи ждут — очередь отправки «Плана» (`personalSync.ts unsentIds`)
const PlannerUnsentMark = ({ id }: OwnProps) => {
  const lang = useLang();
  const isUnsent = useDerivedState(getPlannerUnsent).has(id);

  if (!isUnsent) return undefined;

  return <span className={styles.unsent} data-unsent>{lang('ParvaneUnsentMark')}</span>;
};

export default memo(PlannerUnsentMark);
