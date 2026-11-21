import { createSignal } from '../../util/signals';

// Parvane: текстовая кнопка шапки правой колонки для экрана, который сам решает, когда сохранять (доска `XpChat`:
// «Тип группы · Готово» вместо круглой кнопки внизу). Экран ставит действие, шапка его рисует
export type RightHeaderAction = {
  label: string;
  isDisabled?: boolean;
  onClick: NoneToVoidFunction;
};

const [getRightHeaderAction, setRightHeaderAction] = createSignal<RightHeaderAction | undefined>(undefined);

export { getRightHeaderAction, setRightHeaderAction };
