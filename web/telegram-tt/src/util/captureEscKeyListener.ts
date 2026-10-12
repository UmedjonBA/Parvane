import captureKeyboardListener from './captureKeyboardListeners';

// `false` — клавиша не обработана, её получает следующий слушатель
type IHandlerFunction = () => void | boolean;

export default function captureEscKeyListener(handler: IHandlerFunction) {
  return captureKeyboardListener({ onEsc: handler });
}
