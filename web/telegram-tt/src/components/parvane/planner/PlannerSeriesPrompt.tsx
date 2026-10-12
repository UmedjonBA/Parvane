import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

// Объём правки экземпляра ряда (spec 011, FR-004): только этот день, с этого дня и далее, весь ряд
export type PlannerSeriesScope = 'one' | 'following' | 'all';
// `stop` — только при снятии повтора: ряд кончается этим днём, сам день остаётся разовой записью
export type PlannerPromptScope = PlannerSeriesScope | 'stop';

// О чём вопрос: правка полей, удаление, новое правило повтора, снятие повтора («Не повторяется»).
// Правило одному дню не задать, поэтому у него нет «только это»
export type PlannerSeriesPromptMode = 'edit' | 'delete' | 'rule' | 'stop';

type OwnProps = {
  mode: PlannerSeriesPromptMode;
  onChoose: (scope: PlannerPromptScope) => void;
  onCancel: NoneToVoidFunction;
};

const TITLE_KEYS = {
  edit: 'PlannerSeriesEditTitle',
  delete: 'PlannerSeriesDeleteTitle',
  rule: 'PlannerSeriesRuleTitle',
  stop: 'PlannerSeriesStopTitle',
} as const satisfies Record<PlannerSeriesPromptMode, string>;

const SCOPES: Record<PlannerSeriesPromptMode, PlannerPromptScope[]> = {
  edit: ['one', 'following', 'all'],
  delete: ['one', 'following', 'all'],
  rule: ['following', 'all'],
  stop: ['stop', 'one'],
};

const SCOPE_KEYS = {
  one: 'PlannerSeriesOnlyThis',
  following: 'PlannerSeriesFollowing',
  all: 'PlannerSeriesAll',
  stop: 'PlannerSeriesStop',
} as const satisfies Record<PlannerPromptScope, string>;

const PlannerSeriesPrompt = ({ mode, onChoose, onCancel }: OwnProps) => {
  const lang = useLang();

  const title = lang(TITLE_KEYS[mode]);

  const handleChoose = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onChoose(e.currentTarget.dataset.seriesScope as PlannerPromptScope);
  });

  return (
    <div className={styles.seriesPrompt} role="group" aria-label={title} data-series-prompt={mode}>
      <p className={styles.seriesTitle}>{title}</p>
      {SCOPES[mode].map((scope) => (
        <button
          key={scope}
          type="button"
          className={buildClassName(styles.btn, styles.btnWide)}
          data-series-scope={scope}
          onClick={handleChoose}
        >
          {lang(mode === 'stop' && scope === 'one' ? 'PlannerSeriesOnlyThisDay' : SCOPE_KEYS[scope])}
        </button>
      ))}
      <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onCancel}>
        {lang('Cancel')}
      </button>
    </div>
  );
};

export default memo(PlannerSeriesPrompt);
