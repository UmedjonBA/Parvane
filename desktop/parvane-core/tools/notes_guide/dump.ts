// Выгрузка текстов справки web в JSON для gen.py (см. README.md).
import { writeFileSync } from 'node:fs';

import { GUIDE_EN } from '../../../../web/telegram-tt/src/components/parvane/notes/guide/en';
import { GUIDE_RU } from '../../../../web/telegram-tt/src/components/parvane/notes/guide/ru';

writeFileSync(process.argv[2] || 'guide.json', JSON.stringify({ ru: GUIDE_RU, en: GUIDE_EN }));
