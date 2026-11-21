import type { HealthBlockId } from '../../../util/parvaneModules';
import type { HealthParseResult } from '../health/healthTypes';
import type { QuickKind } from './plannerQuick';

// Parvane (доска `DeskOverlays`): виды окна «Новая запись» — «Авто», записи «Плана», показатели «Здоровья» и
// заметка. Чистая часть: какие виды показать при включённых модулях и какой разбор «Здоровья» годится для вида

export type QuickHealthKind = 'sleep' | 'weight' | 'pressure' | 'pulse' | 'steps' | 'mood';
export type QuickChoice = 'auto' | QuickKind | QuickHealthKind | 'note';

const PLAN_CHOICES: QuickChoice[] = ['event', 'task'];
const SLEEP_KINDS: QuickHealthKind[] = ['sleep'];
const BODY_KINDS: QuickHealthKind[] = ['weight', 'pressure', 'pulse', 'steps', 'mood'];
// Вид записи «Здоровья» → виды разбора, которые ему отвечают (отметки «лёг» и «встал» — тоже сон)
const PARSED_KINDS: Record<QuickHealthKind, string[]> = {
  sleep: ['sleep', 'sleep_start', 'sleep_end'],
  weight: ['weight'],
  pressure: ['pressure'],
  pulse: ['pulse'],
  steps: ['steps'],
  mood: ['mood'],
};

export function isHealthChoice(choice: QuickChoice): choice is QuickHealthKind {
  return choice in PARSED_KINDS;
}

export function isPlanChoice(choice: QuickChoice): choice is QuickKind {
  return choice === 'event' || choice === 'task';
}

/** Виды выбора в порядке доски; виды выключенных модулей и блоков «Здоровья» не предлагаются. */
export function listQuickChoices(
  { isPlanOn, isHealthOn, isNotesOn }: { isPlanOn: boolean; isHealthOn: boolean; isNotesOn: boolean },
  healthBlocks: readonly HealthBlockId[],
): QuickChoice[] {
  const choices: QuickChoice[] = ['auto'];
  if (isPlanOn) choices.push(...PLAN_CHOICES);
  if (isHealthOn) {
    if (healthBlocks.includes('sleep')) choices.push(...SLEEP_KINDS);
    if (healthBlocks.includes('body')) choices.push(...BODY_KINDS);
  }
  if (isNotesOn) choices.push('note');
  return choices;
}

/**
 * Разбор строки для выбранного вида «Здоровья»: сначала строка как есть, затем со словом вида («72» → «вес 72»).
 * Годится разбор, где есть записи и все они этого вида, а непонятых кусков нет.
 */
export function pickHealthParse(
  kind: QuickHealthKind, plain?: HealthParseResult, withWord?: HealthParseResult,
): HealthParseResult | undefined {
  return [plain, withWord].find((parsed) => parsed && isOfKind(parsed, kind));
}

function isOfKind(parsed: HealthParseResult, kind: QuickHealthKind) {
  const kinds = PARSED_KINDS[kind];
  return parsed.entries.length > 0 && !parsed.unparsed.length
    && parsed.entries.every((entry) => kinds.includes(entry.kind));
}
