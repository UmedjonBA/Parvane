import {
  afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import type { FC } from '../../lib/teact/teact';
import Teact from '../../lib/teact/teact';
import TeactDOM from '../../lib/teact/teact-dom';

import { SEARCH_FIELD_PROPS } from '../../util/searchField';

// Разметка поля поиска глазами менеджера паролей Firefox (эвристика — в `util/searchField.ts`): поле лежит в
// своей форме без паролей, а пароли настроек — в своих формах, так что «бесформенной» группы, где поиск
// оказался бы логином перед паролем, на странице нет

const NO_COMPONENT = { default: () => undefined };

vi.mock('../../hooks/useLang', () => ({ default: () => Object.assign((key: string) => key, { isRtl: false }) }));
vi.mock('../../hooks/useOldLang', () => ({ default: () => (key: string) => key }));
vi.mock('../../hooks/useInputFocusOnOpen', () => ({ default: () => undefined }));
vi.mock('../common/icons/Icon', () => NO_COMPONENT);
vi.mock('./Button', () => NO_COMPONENT);
vi.mock('./Loading', () => NO_COMPONENT);
vi.mock('./Transition', () => NO_COMPONENT);

// Признаки из исходников Firefox: `LoginHelper.isInferredNonUsernameField` и типы, для которых форма без пароля
// поднимает событие «возможный логин» (`HTMLInputElement::MaybeDispatchLoginManagerEvents`)
const NOT_USERNAME = /\b(search|code|add)\b/i;
const POSSIBLE_USERNAME_TYPES = ['text', 'email'];
const FRAME_MS = 50;

let SearchInput: FC;
let SearchForm: FC;
let SecretForm: FC;
let root: HTMLElement;

const frame = () => new Promise((resolve) => {
  setTimeout(resolve, FRAME_MS);
});
const h = Teact.createElement as (...args: unknown[]) => unknown;

async function mount(element: unknown) {
  root = document.createElement('div');
  document.body.appendChild(root);
  TeactDOM.render(element as Parameters<typeof TeactDOM.render>[0], root);
  await frame();
}

// Группа поля, как её строит `FormLikeFactory.createFromField`: ближайшая форма, иначе все поля страницы вне форм
function loginGroupOf(field: HTMLInputElement) {
  const inputs = Array.from(document.querySelectorAll('input'));
  return field.form ? inputs.filter((input) => input.form === field.form) : inputs.filter((input) => !input.form);
}

function expectSearchField(field: HTMLInputElement) {
  const form = field.form!;
  expect(form).toBeTruthy();
  expect(form.getAttribute('role')).toBe('search');
  expect(field.type).toBe('search');
  expect(POSSIBLE_USERNAME_TYPES).not.toContain(field.type);
  expect(field.name).toMatch(NOT_USERNAME);
  expect(field.autocomplete).toBe('off');
  expect(field.getAttribute('data-lpignore')).toBe('true');
  expect(field.getAttribute('data-1p-ignore')).toBe('true');
  expect(field.getAttribute('data-form-type')).toBe('other');
  expect(loginGroupOf(field).some((input) => input.type === 'password')).toBe(false);
}

beforeAll(async () => {
  Object.assign(window, {
    CSS: { supports: () => false },
    matchMedia: () => ({
      matches: false, addEventListener: () => undefined, removeEventListener: () => undefined,
    }),
  });
  SearchInput = (await import('./SearchInput')).default as FC;
  SearchForm = (await import('./SearchForm')).default as FC;
  SecretForm = (await import('./SecretForm')).default as FC;
});

afterEach(() => {
  TeactDOM.render(undefined, root);
  root.remove();
});

describe('поле поиска и менеджер паролей', () => {
  it('SearchInput лежит в своей форме поиска и не попадает в группу с полем пароля', async () => {
    await mount(h('div', {},
      h(SearchInput, { inputId: 'telegram-search-input', value: '', onChange: () => undefined }),
      h(SecretForm, { className: 'settings-item' },
        h('input', { type: 'password', autoComplete: 'current-password' }))));

    const field = root.querySelector<HTMLInputElement>('#telegram-search-input')!;
    expectSearchField(field);
    expect(field.form!.classList.contains('SearchInput')).toBe(true);

    // Поле пароля — в собственной форме, и текстовых полей перед ним в ней нет
    const password = root.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(password.form).toBeTruthy();
    expect(password.form).not.toBe(field.form);
    expect(loginGroupOf(password)).toEqual([password]);
    expect(Array.from(document.querySelectorAll('input')).filter((input) => !input.form)).toEqual([]);
  });

  it('отправка формы поиска не уводит со страницы', async () => {
    await mount(h(SearchInput, { value: '', onChange: () => undefined }));

    const event = new Event('submit', { bubbles: true, cancelable: true });
    root.querySelector('form')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('автозаполненный без фокуса текст не доходит до поиска', async () => {
    const onChange = vi.fn();
    await mount(h(SearchInput, { value: '', onChange }));

    const field = root.querySelector<HTMLInputElement>('input')!;
    field.value = 'umedon';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    expect(field.value).toBe('');
  });

  it('поле вне SearchInput получает те же признаки через SearchForm', async () => {
    await mount(h('div', {},
      h(SearchForm, {},
        h('label', {}, h('input', { ...SEARCH_FIELD_PROPS, id: 'knowledge-search' }))),
      h(SecretForm, {}, h('input', { type: 'password' }))));

    expectSearchField(root.querySelector<HTMLInputElement>('#knowledge-search')!);
  });
});
