import type { ActionOptions } from '../lib/teact/teactn';
import { typify } from '../lib/teact/teactn';

import type {
  ActionPayloads, GlobalState, RequiredActionPayloads, RequiredGlobalState,
} from './types';

import { diagLog, installParvaneDiag } from '../util/parvaneDiag';

const typed = typify<GlobalState, ActionPayloads & RequiredActionPayloads>();

type ProjectActionTypes =
  ActionPayloads
  & RequiredActionPayloads;

type ProjectActionNames = keyof ProjectActionTypes;

type Helper<T, E> = Exclude<T, E> extends never ? unknown : Exclude<T, E>;

export type TabStateActionNames = {
  [ActionName in ProjectActionNames]:
  'tabId' extends keyof Helper<ProjectActionTypes[ActionName], undefined> ? ActionName : never
}[ProjectActionNames];
// `Required` actions are called from actions to ensure the `tabId` is always provided if needed.
// There are three types of actions:
// 1. With tabId, which is made required when calling action from another action handler
// 2. Without payload (= undefined), hence made the payload not required
// 3. With payload, hence made the payload required
export type RequiredGlobalActions = {
  [ActionName in ProjectActionNames]: ActionName extends TabStateActionNames ? ((
    payload: ProjectActionTypes[ActionName] & { tabId: number },
    options?: ActionOptions,
  ) => void) :
    (undefined extends ProjectActionTypes[ActionName] ? (
      (payload?: ProjectActionTypes[ActionName], options?: ActionOptions) => void
    ) : (
      (payload: ProjectActionTypes[ActionName], options?: ActionOptions) => void
    ))
} & { _: never };

type ActionHandlers = {
  [ActionName in keyof ProjectActionTypes]: (
    global: RequiredGlobalState,
    actions: RequiredGlobalActions,
    payload: ProjectActionTypes[ActionName],
  ) => GlobalState | void | Promise<void>;
};

export const getGlobal = typed.getGlobal;
export const setGlobal = typed.setGlobal;
// Parvane: read-only доступ к global из консоли/e2e для диагностики состояния
// ленты (viewportIds/lastMessageId) в реальном браузере. Без setGlobal.
// Только в e2e/dev-сборках (VITE_PARVANE_DIAG_HOOKS=1): в проде любой XSS
// получил бы через хуки полный стейт
if (import.meta.env.VITE_PARVANE_DIAG_HOOKS === '1') {
  (window as unknown as { __parvaneGetGlobal?: typeof getGlobal }).__parvaneGetGlobal = getGlobal;
}
export const getActions = typed.getActions;
export const getPromiseActions = typed.getPromiseActions;
// parvaneDiag: временный журнал действий (см. util/parvaneDiag.ts) — каждое
// действие UI пишется в кольцевой буфер (apiUpdate журналится в провайдере).
installParvaneDiag();
type AddActionHandler = <ActionName extends ProjectActionNames>(
  name: ActionName,
  handler: ActionHandlers[ActionName],
) => void;
export const addActionHandler: AddActionHandler = (name, handler) => {
  (typed.addActionHandler as AddActionHandler)(name, ((global, actions, payload) => {
    if (name !== 'apiUpdate') diagLog(`act:${String(name)}`, payload);
    return handler(global, actions, payload);
  }) as typeof handler);
};
export const execAfterActions = typed.execAfterActions;
export const withGlobal = typed.withGlobal;
export type GlobalActions = ReturnType<typeof getActions>;
