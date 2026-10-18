# Тексты справки «Знаний» для desktop

`src/sections/notes_guide_texts.cpp` выгружается из web `components/parvane/notes/guide/{ru,en}.ts`
(из корня репозитория):

    web/telegram-tt/node_modules/.bin/tsx desktop/parvane-core/tools/notes_guide/dump.ts /tmp/guide.json
    python3 desktop/parvane-core/tools/notes_guide/gen.py /tmp/guide.json \
        desktop/parvane-core/src/sections/notes_guide_texts.cpp

Правка текстов — сначала в web, затем повторная выгрузка.
