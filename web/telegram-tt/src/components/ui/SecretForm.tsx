import type { TeactNode } from '../../lib/teact/teact';
import { memo } from '../../lib/teact/teact';

import stopEvent from '../../util/stopEvent';

type OwnProps = {
  className?: string;
  children: TeactNode;
};

// Parvane: поля пароля вне экранов входа (подтверждение паролем, смена пароля, PIN) лежат в собственной
// форме. Поле пароля без формы менеджер паролей Firefox объединяет со ВСЕМИ полями страницы вне форм и
// первое текстовое перед ним считает логином — так логин попадал в поле поиска (см. `util/searchField.ts`)
const SecretForm = ({ className, children }: OwnProps) => {
  return (
    <form className={className} action="" onSubmit={stopEvent}>
      {children}
    </form>
  );
};

export default memo(SecretForm);
