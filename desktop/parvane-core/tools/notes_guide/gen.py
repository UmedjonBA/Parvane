import json, sys
d = json.load(open(sys.argv[1]))
out = []
out.append('// Parvane fork (spec 029, фаза 4): тексты справки Parvane — данные web `notes/guide/ru.ts` и `notes/guide/en.ts`,')
out.append('// перенесённые как есть (сгенерировано из них: заметка — `lines.join("\\n")`). Это содержимое файлов `.md`')
out.append('// пользователя, а не строки интерфейса. Правка текстов — сначала в web, затем повторная выгрузка сюда.')
out.append('#include "notes_guide_texts.h"')
out.append('')
out.append('namespace parvane::sections::notes::guide {')
out.append('')
def s(v):
    assert ')PV"' not in v
    return 'R"PV(' + v + ')PV"'
for lang in ['ru', 'en']:
    g = d[lang]
    out.append(f'const GuideSet &{lang}Set() {{')
    out.append('    static const GuideSet set{')
    out.append(f'        {s(g["folderName"])},')
    out.append('        {')
    for n in g['notes']:
        out.append(f'            {{"{n["key"]}", {n["slot"]}, {s(n["title"])},')
        out.append(f'             {s(chr(10).join(n["lines"]))}}},')
    out.append('        },')
    out.append('        {' + ', '.join(s(x) for x in g['datedSamples']) + '},')
    out.append('        {')
    for q in g['quickSamples']:
        out.append(f'            {{{s(q["text"])}, "{q["kind"]}"}},')
    out.append('        },')
    out.append('    };')
    out.append('    return set;')
    out.append('}')
    out.append('')
out.append('} // namespace parvane::sections::notes::guide')
open(sys.argv[2], 'w').write('\n'.join(out) + '\n')
