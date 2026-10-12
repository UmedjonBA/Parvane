import type { TeactNode } from '../../lib/teact/teact';
import { memo } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';
import { SEARCH_FORM_PROPS } from '../../util/searchField';

type OwnProps = {
  className?: string;
  children: TeactNode;
};

// Parvane: обёртка поля поиска, нарисованного не через `SearchInput`. Сама места не занимает
// (`display: contents`, `_forms.scss`); поле внутри получает `SEARCH_FIELD_PROPS` — см. `util/searchField.ts`
const SearchForm = ({ className, children }: OwnProps) => {
  return (
    <form className={buildClassName('SearchForm', className)} {...SEARCH_FORM_PROPS}>
      {children}
    </form>
  );
};

export default memo(SearchForm);
