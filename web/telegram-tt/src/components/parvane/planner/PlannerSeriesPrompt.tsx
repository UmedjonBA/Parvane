import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatCardDay, formatSeriesAsk } from './plannerEditorFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import PvSheet from '../notes/PvSheet';

import styles from './Planner.module.scss';

// Объём правки экземпляра ряда (spec 011, FR-004): только этот день, с этого дня и далее, весь ряд
export type PlannerSeriesScope = 'one' | 'following' | 'all';
// `stop` — ряд кончается этим днём, сам день остаётся разовой записью (с правкой, если она была)
export type PlannerPromptScope = PlannerSeriesScope | 'stop';

// О чём вопрос: правка полей, удаление, новое правило повтора, снятие повтора («Не повторяется»).
// Правило одному дню не задать, поэтому у него нет «только это». `copy` — правка отделённого дня ряда: только
// он либо весь ряд вместе с остальными отделёнными днями
export type PlannerSeriesPromptMode = 'edit' | 'delete' | 'rule' | 'stop' | 'copy';

type OwnProps = {
  mode: PlannerSeriesPromptMode;
  // Запись и её правило словами («каждую неделю») — для пояснения (доска `XpPlan`)
  name: string;
  rule?: string;
  // День экземпляра: «Только это · вс, 15 ноября»
  day?: string;
  // Правка меняет только время — пояснение его называет
  newTime?: string;
  onChoose: (scope: PlannerPromptScope) => void;
  onCancel: NoneToVoidFunction;
};

const SCOPES: Record<PlannerSeriesPromptMode, PlannerPromptScope[]> = {
  edit: ['one', 'following', 'all', 'stop'],
  delete: ['one', 'following', 'all'],
  rule: ['following', 'all'],
  stop: ['stop', 'one'],
  copy: ['one', 'all'],
};

const SCOPE_KEYS = {
  one: 'PlannerSeriesOnlyThis',
  following: 'PlannerSeriesFollowing',
  all: 'PlannerSeriesAll',
  stop: 'PlannerSeriesStop',
} as const satisfies Record<PlannerPromptScope, string>;

// Ширина, до которой «План» — одна колонка (`Planner.module.scss`)
const NARROW_WIDTH = 925;

// Выбор объёма правки ряда: на компьютере — блок в карточке, на телефоне — шторка поверх карточки (доска `XpPlan`)
const PlannerSeriesPrompt = ({
  mode, name, rule, day, newTime, onChoose, onCancel,
}: OwnProps) => {
  const lang = useLang();
  const { width } = useWindowSize();
  const isNarrow = width <= NARROW_WIDTH;

  const title = lang(mode === 'delete' ? 'PlannerSeriesDeleteEntryTitle' : 'PlannerSeriesChangeTitle');
  const ask = formatSeriesAsk(lang, mode, name, rule || '', newTime);

  const handleChoose = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onChoose(e.currentTarget.dataset.seriesScope as PlannerPromptScope);
  });

  function renderLabel(scope: PlannerPromptScope) {
    if (scope === 'one' && mode === 'stop') return lang('PlannerSeriesOnlyThisDay');
    if (scope === 'one' && day) return lang('PlannerSeriesOnlyThisOn', { date: formatCardDay(lang, day) });
    return lang(SCOPE_KEYS[scope]);
  }

  const body = (
    <div className={styles.seriesPrompt} role="group" aria-label={title} data-series-prompt={mode}>
      {!isNarrow && <p className={styles.seriesTitle}>{title}</p>}
      <p className={styles.seriesAsk} data-series-ask>{ask}</p>
      {SCOPES[mode].map((scope) => (
        <button
          key={scope}
          type="button"
          className={buildClassName(
            styles.btn, styles.btnWide, scope === 'stop' && mode !== 'stop' && styles.btnDanger,
          )}
          data-series-scope={scope}
          onClick={handleChoose}
        >
          {renderLabel(scope)}
        </button>
      ))}
      <button type="button" className={styles.seriesCancel} onClick={onCancel}>
        {lang('Cancel')}
      </button>
    </div>
  );

  if (!isNarrow) return body;
  return (
    <PvSheet isOpen title={title} onClose={onCancel}>
      {body}
    </PvSheet>
  );
};

export default memo(PlannerSeriesPrompt);
