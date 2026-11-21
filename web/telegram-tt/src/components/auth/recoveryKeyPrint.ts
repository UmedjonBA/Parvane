// Ключ восстановления на экране и на бумаге (доски `XpAuth`, `RdAuth`): на телефоне ключ — в две строки по группам,
// «Напечатать» печатает только ключ отдельным документом, а не всю страницу

const GROUP_SEPARATOR = '-';
const PRINT_CLEANUP_MS = 60000;

/** Ключ «K7QF-2M9D-XT4H-PW3N» → две строки «K7QF-2M9D», «XT4H-PW3N» (нечётное число групп — длиннее первая). */
export function splitRecoveryKey(key: string): string[] {
  const groups = key.trim().split(GROUP_SEPARATOR).filter(Boolean);
  if (groups.length < 2) return [key.trim()];
  const half = Math.ceil(groups.length / 2);
  return [groups.slice(0, half).join(GROUP_SEPARATOR), groups.slice(half).join(GROUP_SEPARATOR)];
}

/** Печать одного ключа: скрытая рамка с заголовком, ключом и подсказкой, где хранить. */
export function printRecoveryKey(title: string, key: string, hint: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position: fixed; width: 0; height: 0; border: 0; visibility: hidden;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (!doc || !view) {
    frame.remove();
    return;
  }
  doc.title = title;
  const heading = doc.createElement('h1');
  heading.textContent = title;
  heading.style.cssText = 'font: 600 20px sans-serif; margin: 0 0 16px;';
  const code = doc.createElement('p');
  code.textContent = key;
  code.style.cssText = 'font: 24px monospace; letter-spacing: 0.06em; margin: 0 0 16px;';
  const note = doc.createElement('p');
  note.textContent = hint;
  note.style.cssText = 'font: 14px sans-serif; margin: 0;';
  doc.body.append(heading, code, note);
  const remove = () => frame.remove();
  view.addEventListener('afterprint', remove, { once: true });
  window.setTimeout(remove, PRINT_CLEANUP_MS);
  view.focus();
  view.print();
}
