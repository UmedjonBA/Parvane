// Parvane: поле поиска и менеджеры паролей. Firefox принимал поиск за поле логина: поле без `<form>` попадает
// в одну «бесформенную» группу со всеми полями пароля страницы, и первое текстовое поле перед паролем считается
// логином (LoginManagerChild `_getFormFields`) — браузер подставлял в него логин, красил автозаполнением и по
// фокусу предлагал сохранённые учётные записи. `autocomplete="off"` на это не влияет
// (`LoginHelper.isUsernameFieldType` принимает `off`), тип `search` тоже (он «совместим с логином»).
//
// Поэтому признаки собраны в одном месте и ставятся на КАЖДОЕ поле поиска:
// - своя форма `role="search"` без полей пароля — группа поля ограничена этой формой
//   (`FormLikeFactory.createFromField` берёт ближайший `<form>`), пароли других форм её не касаются;
// - `type="search"` — для формы без пароля Firefox вообще не поднимает событие «возможный логин»
//   (`HTMLInputElement::MaybeDispatchLoginManagerEvents` — только `text` и `email`);
// - слово `search` в `name` — `LoginHelper.isInferredNonUsernameField` (`/\b(search|code|add)\b/` по id, name,
//   классу, подписи и подсказке) исключает поле из «формы с одним логином»;
// - отметки для сторонних менеджеров (LastPass, 1Password, Bitwarden, Dashlane).
// Вторая половина лекарства — поля пароля в настройках лежат в своих формах (см. `SettingsPrivacy`).

export const SEARCH_FIELD_NAME = 'search';

export const SEARCH_FIELD_PROPS = {
  type: 'search',
  name: SEARCH_FIELD_NAME,
  autoComplete: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

export function preventSearchSubmit(e: { preventDefault: NoneToVoidFunction }) {
  e.preventDefault();
}

export const SEARCH_FORM_PROPS = {
  role: 'search',
  action: '',
  autoComplete: 'off',
  noValidate: true,
  onSubmit: preventSearchSubmit,
} as const;
