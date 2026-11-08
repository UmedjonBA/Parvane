//! spec 035 T052 (US5, FR-041/FR-042): критичность номером вида. Векторы руками:
//! `content/critical.json` — показ содержимого по исходным байтам (`show` / `stub` / `stub_critical`) и что
//! разрешено (ответ, правка, пересылка); `model/critical_journal.json` — критичный вид в журнале закрывает его
//! для записи, показ известного работает. Прогон — `conformance::run`, его же зовут обвязки клиентов.

mod common;

use common::*;

#[test]
fn critical_vectors() {
    for (suite, file, least) in [("content/critical", "content/critical.json", 7), ("model/critical_journal", "model/critical_journal.json", 4)] {
        let (dir, name) = file.split_once('/').unwrap();
        let json = std::fs::read_to_string(vectors_dir(dir).join(name)).unwrap();
        let n = parvane_protocol::conformance::run(suite, &json).unwrap_or_else(|e| panic!("{e}"));
        assert!(n >= least, "{suite}: {n}");
    }
}
