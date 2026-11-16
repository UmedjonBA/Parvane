import { createPersonalSync, type PersonalDeps, type PersonalSpec } from './personalSync';
import { coalesceChanges } from './plannerCoalesce';

// Parvane (spec 010): планировщик на сервере — личный контейнер домена `parvane.planner.v1`. Жизненный цикл
// общий с «Здоровьем» — `personalSync.ts`
export const PLANNER_DOMAIN = 'parvane.planner.v1';

const PLANNER_SPEC: PersonalSpec = {
  kind: 'planner',
  domain: PLANNER_DOMAIN,
  label: 'планировщик',
  outboxRecord: 'planner-outbox',
  pendingRecord: 'planner-pending',
  coalesce: coalesceChanges,
};

export function createPlannerSync(deps: PersonalDeps) {
  return createPersonalSync(deps, PLANNER_SPEC);
}

export type { PersonalSyncStatus as PlannerSyncStatus } from './personalSync';
export type PlannerSync = ReturnType<typeof createPlannerSync>;
