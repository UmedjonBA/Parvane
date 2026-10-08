//! Домен планировщика `parvane.planner.v1` (spec 010, T007): сведение
//! коммутативно и идемпотентно, надгробия устойчивы, равные метки сводятся
//! детерминированно, LamportGuard держит «вечного победителя», лимиты
//! значений отбрасывают негодные изменения по одному; снимок == сведение.

use parvane_protocol::domain::planner::{self, PlannerState, SNAPSHOT_WARN_BYTES};
use parvane_protocol::domain::{LamportGuard, Stamp};
use parvane_protocol::pb::parvane::core::v2::LwwStamp;
use parvane_protocol::pb::parvane::planner::v1::{
    change, Bool, Change, Event, FoodEntry, Goal, GoalPeriod, GoalSet, List, NutritionDay, Occurrence, PlannerOp, Repeat,
    RepeatKind, Settings, Step, Steps, Str, Task, I32, U32,
};
use parvane_protocol::ProtoError;
use prost::Message;
use proptest::prelude::*;

fn st(lamport: u64, dev: &str) -> Option<LwwStamp> {
    Some(LwwStamp { lamport, device_id: dev.into() })
}

fn s(value: &str, lamport: u64, dev: &str) -> Option<Str> {
    Some(Str { stamp: st(lamport, dev), value: value.into() })
}

fn task(id: &str, name: &str, lamport: u64, dev: &str) -> Task {
    Task {
        id: id.into(),
        name: s(name, lamport, dev),
        description: s("", lamport, dev),
        status: s("queue", lamport, dev),
        list_id: s("", lamport, dev),
        rank: Some(I32 { stamp: st(lamport, dev), value: 0 }),
        day: s("2026-10-08", lamport, dev),
        start: s("10:00", lamport, dev),
        due: s("", lamport, dev),
        minutes: Some(U32 { stamp: st(lamport, dev), value: 60, unset: false }),
        steps: Some(Steps { stamp: st(lamport, dev), items: vec![Step { text: "шаг".into(), is_done: false }] }),
        deleted: None,
        ..Default::default()
    }
}

fn occ(day: &str, lamport: u64, dev: &str, done: bool, excluded: bool) -> Occurrence {
    Occurrence { day: day.into(), stamp: st(lamport, dev), excluded, done, done_steps: vec![] }
}

fn weekly(lamport: u64, dev: &str, weekdays: Vec<u32>, start: &str, end: &str) -> Option<Repeat> {
    Some(Repeat {
        stamp: st(lamport, dev),
        kind: RepeatKind::Weekly as i32,
        interval: 1,
        weekdays,
        month_day: 0,
        start_day: start.into(),
        end_day: end.into(),
        count: 0,
    })
}

// ── spec 011: повторы, экземпляры, цели по датам ────────────────────────────

#[test]
fn occurrences_merge_per_day_from_two_devices() {
    // d1 отметил 2 окт, d2 без связи — 3 окт и исключил 4 окт: все три отметки объединяются.
    let a = change::Change::Task(Task { id: "t".into(), occurrences: vec![occ("2026-10-02", 5, "d1", true, false)], ..Default::default() });
    let b = change::Change::Task(Task { id: "t".into(), occurrences: vec![occ("2026-10-03", 3, "d2", true, false), occ("2026-10-04", 3, "d2", false, true)], ..Default::default() });
    // d1 позже снял отметку 3 окт.
    let c = change::Change::Task(Task { id: "t".into(), occurrences: vec![occ("2026-10-03", 7, "d1", false, false)], ..Default::default() });
    let mut x = PlannerState::default();
    let mut y = PlannerState::default();
    for ch in [&a, &b, &c] {
        x.apply_change(&Change { change: Some(ch.clone()) }).unwrap();
    }
    for ch in [&c, &b, &a] {
        y.apply_change(&Change { change: Some(ch.clone()) }).unwrap();
    }
    assert_eq!(snapshot_bytes(&x), snapshot_bytes(&y));
    let t = &x.tasks["t"];
    let days: Vec<(&str, bool, bool)> = t.occurrences.iter().map(|o| (o.day.as_str(), o.done, o.excluded)).collect();
    assert_eq!(days, vec![("2026-10-02", true, false), ("2026-10-03", false, false), ("2026-10-04", false, true)]);
    // Отметка экземпляра делает задачу «живой» (метка новее надгробия).
    assert!(PlannerState::is_task_alive(t));
}

#[test]
fn repeat_is_a_whole_register_and_invalid_rule_is_skipped() {
    let mut st_ = PlannerState::default();
    let ok = Task { id: "e".into(), name: s("Бассейн", 1, "d1"), repeat: weekly(1, "d1", vec![1, 3], "2026-10-12", ""), ..Default::default() };
    st_.apply_change(&Change { change: Some(change::Change::Task(ok)) }).unwrap();
    // Поздняя правка всего правила заменяет его целиком (end_day, другие дни).
    let later = Task { id: "e".into(), repeat: weekly(4, "d2", vec![5], "2026-10-12", "2026-12-31"), ..Default::default() };
    st_.apply_change(&Change { change: Some(change::Change::Task(later)) }).unwrap();
    assert_eq!(st_.tasks["e"].repeat.as_ref().unwrap().weekdays, vec![5]);
    assert_eq!(st_.tasks["e"].repeat.as_ref().unwrap().end_day, "2026-12-31");
    // Старая правка правила не побеждает.
    let older = Task { id: "e".into(), repeat: weekly(2, "d1", vec![0], "2026-10-12", ""), ..Default::default() };
    st_.apply_change(&Change { change: Some(change::Change::Task(older)) }).unwrap();
    assert_eq!(st_.tasks["e"].repeat.as_ref().unwrap().weekdays, vec![5]);
    // Негодные правила: шаг 0, конец раньше начала, еженедельно без дней, 101 отмеченный шаг.
    let bad = |r: Repeat| Change { change: Some(change::Change::Task(Task { id: "e".into(), repeat: Some(r), ..Default::default() })) };
    let base = weekly(9, "d1", vec![1], "2026-10-12", "").unwrap();
    assert!(matches!(st_.apply_change(&bad(Repeat { interval: 0, ..base.clone() })), Err(ProtoError::InvalidField("interval"))));
    assert!(matches!(st_.apply_change(&bad(Repeat { end_day: "2026-10-01".into(), ..base.clone() })), Err(ProtoError::InvalidField("end_day"))));
    assert!(matches!(st_.apply_change(&bad(Repeat { weekdays: vec![], ..base.clone() })), Err(ProtoError::InvalidField("weekdays"))));
    assert!(matches!(st_.apply_change(&bad(Repeat { weekdays: vec![1, 1], ..base.clone() })), Err(ProtoError::InvalidField("weekdays"))));
    assert!(matches!(st_.apply_change(&bad(Repeat { count: 1000, ..base.clone() })), Err(ProtoError::InvalidField("repeat"))));
    let many = Change { change: Some(change::Change::Event(Event { id: "x".into(), occurrences: vec![Occurrence { day: "2026-10-01".into(), stamp: st(1, "d1"), done_steps: (0..101).collect(), ..Default::default() }], ..Default::default() })) };
    assert!(matches!(st_.apply_change(&many), Err(ProtoError::InvalidField("occurrence"))));
    assert_eq!(st_.tasks["e"].repeat.as_ref().unwrap().weekdays, vec![5]);
}

#[test]
fn goal_period_merges_whole_and_tombstone_is_stable() {
    let goal = |t: u32| Some(Goal { target: t, tolerance: 10, set: true });
    let p = |lamport: u64, dev: &str, kcal: u32| GoalPeriod {
        id: "g".into(),
        stamp: st(lamport, dev),
        start_day: "2026-10-15".into(),
        end_day: "2026-10-20".into(),
        kcal: goal(kcal),
        water: Some(Goal { target: 2000, tolerance: 300, set: true }),
        ..Default::default()
    };
    let mut a = PlannerState::default();
    a.apply_change(&Change { change: Some(change::Change::GoalPeriod(p(2, "d1", 1800))) }).unwrap();
    a.apply_change(&Change { change: Some(change::Change::GoalPeriod(p(1, "d2", 1500))) }).unwrap();
    assert_eq!(a.goal_periods["g"].kcal.as_ref().unwrap().target, 1800);
    // Надгробие с меткой 3 скрывает; правка с меткой 2 не воскрешает, с меткой 4 — воскрешает.
    let del = GoalPeriod { id: "g".into(), deleted: st(3, "d1"), ..Default::default() };
    a.apply_change(&Change { change: Some(change::Change::GoalPeriod(del)) }).unwrap();
    assert!(!PlannerState::is_goal_period_alive(&a.goal_periods["g"]));
    a.apply_change(&Change { change: Some(change::Change::GoalPeriod(p(2, "d3", 1700))) }).unwrap();
    assert!(!PlannerState::is_goal_period_alive(&a.goal_periods["g"]));
    a.apply_change(&Change { change: Some(change::Change::GoalPeriod(p(4, "d2", 1600))) }).unwrap();
    assert!(PlannerState::is_goal_period_alive(&a.goal_periods["g"]));
    assert_eq!(a.goal_periods["g"].kcal.as_ref().unwrap().target, 1600);
    // Негодная запись: конец раньше начала, цель с допуском больше значения; незаданный показатель не проверяется.
    let bad = GoalPeriod { end_day: "2026-10-01".into(), ..p(5, "d1", 1000) };
    assert!(matches!(a.apply_change(&Change { change: Some(change::Change::GoalPeriod(bad)) }), Err(ProtoError::InvalidField("end_day"))));
    let bad_goal = GoalPeriod { fiber: Some(Goal { target: 10, tolerance: 20, set: true }), ..p(5, "d1", 1000) };
    assert!(a.apply_change(&Change { change: Some(change::Change::GoalPeriod(bad_goal)) }).is_err());
    let unset_goal = GoalPeriod { fiber: Some(Goal { target: 0, tolerance: 0, set: false }), ..p(5, "d1", 1000) };
    a.apply_change(&Change { change: Some(change::Change::GoalPeriod(unset_goal)) }).unwrap();
    // Снимок несёт записи целей.
    let snap = a.to_snapshot();
    assert_eq!(snap.goal_periods.len(), 1);
    assert_eq!(snapshot_bytes(&PlannerState::from_snapshot(&snap).unwrap()), snapshot_bytes(&a));
}

fn op(changes: Vec<change::Change>) -> PlannerOp {
    PlannerOp { changes: changes.into_iter().map(|c| Change { change: Some(c) }).collect() }
}

fn snapshot_bytes(state: &PlannerState) -> Vec<u8> {
    state.to_snapshot().encode_to_vec()
}

#[test]
fn fields_merge_by_stamp_and_snapshot_roundtrips() {
    let mut a = PlannerState::default();
    // d1 создаёт задачу, d2 позже меняет название, d1 ещё позже — статус.
    a.apply_op(&op(vec![change::Change::Task(task("t1", "первая", 1, "d1"))]), "d1").unwrap();
    let rename = Task { id: "t1".into(), name: s("вторая", 2, "d2"), ..Default::default() };
    a.apply_op(&op(vec![change::Change::Task(rename.clone())]), "d2").unwrap();
    let status = Task { id: "t1".into(), status: s("active", 3, "d1"), ..Default::default() };
    a.apply_op(&op(vec![change::Change::Task(status.clone())]), "d1").unwrap();
    let t = &a.tasks["t1"];
    assert_eq!(t.name.as_ref().unwrap().value, "вторая");
    assert_eq!(t.status.as_ref().unwrap().value, "active");
    assert_eq!(t.minutes.as_ref().unwrap().value, 60);

    // Другой порядок — тот же снимок.
    let mut b = PlannerState::default();
    b.apply_op(&op(vec![change::Change::Task(status)]), "d1").unwrap();
    b.apply_op(&op(vec![change::Change::Task(rename)]), "d2").unwrap();
    b.apply_op(&op(vec![change::Change::Task(task("t1", "первая", 1, "d1"))]), "d1").unwrap();
    assert_eq!(snapshot_bytes(&a), snapshot_bytes(&b));

    // Снимок читается в то же состояние; повторное слияние идемпотентно.
    let restored = PlannerState::from_snapshot(&a.to_snapshot()).unwrap();
    assert_eq!(restored, a);
    let mut again = restored.clone();
    again.merge_snapshot(&a.to_snapshot()).unwrap();
    assert_eq!(again, a);
}

#[test]
fn tombstone_is_stable_and_newer_edit_resurrects() {
    let mut a = PlannerState::default();
    a.apply_op(&op(vec![change::Change::Task(task("t1", "x", 1, "d1"))]), "d1").unwrap();
    let del = Task { id: "t1".into(), deleted: st(5, "d2"), ..Default::default() };
    a.apply_op(&op(vec![change::Change::Task(del.clone())]), "d2").unwrap();
    assert!(!PlannerState::is_task_alive(&a.tasks["t1"]));
    // Старая правка (lamport 3 < 5) после удаления не воскрешает.
    let old = Task { id: "t1".into(), name: s("старое", 3, "d1"), ..Default::default() };
    a.apply_op(&op(vec![change::Change::Task(old.clone())]), "d1").unwrap();
    assert!(!PlannerState::is_task_alive(&a.tasks["t1"]));
    // Новая правка (7 > 5) — воскрешает с новым именем.
    let fresh = Task { id: "t1".into(), name: s("новое", 7, "d1"), ..Default::default() };
    a.apply_op(&op(vec![change::Change::Task(fresh.clone())]), "d1").unwrap();
    assert!(PlannerState::is_task_alive(&a.tasks["t1"]));
    assert_eq!(a.tasks["t1"].name.as_ref().unwrap().value, "новое");

    // Тот же набор в другом порядке — тот же результат.
    let mut b = PlannerState::default();
    b.apply_op(&op(vec![change::Change::Task(fresh)]), "d1").unwrap();
    b.apply_op(&op(vec![change::Change::Task(old)]), "d1").unwrap();
    b.apply_op(&op(vec![change::Change::Task(del)]), "d2").unwrap();
    b.apply_op(&op(vec![change::Change::Task(task("t1", "x", 1, "d1"))]), "d1").unwrap();
    assert_eq!(snapshot_bytes(&a), snapshot_bytes(&b));
}

#[test]
fn equal_stamps_break_ties_deterministically() {
    let x = Task { id: "t".into(), name: s("a", 4, "d1"), ..Default::default() };
    let y = Task { id: "t".into(), name: s("b", 4, "d1"), ..Default::default() };
    let mut p = PlannerState::default();
    p.apply_op(&op(vec![change::Change::Task(x.clone())]), "d1").unwrap();
    p.apply_op(&op(vec![change::Change::Task(y.clone())]), "d1").unwrap();
    let mut q = PlannerState::default();
    q.apply_op(&op(vec![change::Change::Task(y)]), "d1").unwrap();
    q.apply_op(&op(vec![change::Change::Task(x)]), "d1").unwrap();
    assert_eq!(snapshot_bytes(&p), snapshot_bytes(&q));
    assert_eq!(p.tasks["t"].name.as_ref().unwrap().value, "b");
}

#[test]
fn foreign_stamp_and_lamport_jump_are_rejected() {
    let mut a = PlannerState::default();
    // Метка чужого устройства в операции автора d1 — отказ на всю операцию.
    let err = a.apply_op(&op(vec![change::Change::Task(task("t1", "x", 1, "d2"))]), "d1").unwrap_err();
    assert_eq!(err, ProtoError::ContextMismatch);
    assert!(a.tasks.is_empty());
    // Операция без меток — негодна.
    assert!(a.apply_op(&PlannerOp::default(), "d1").is_err());
    // LamportGuard: скачок больше 2^20 — отказ.
    let mut g = LamportGuard::default();
    assert!(planner::guard_op(&mut g, &op(vec![change::Change::Task(task("t1", "x", 10, "d1"))])).is_ok());
    assert!(planner::guard_op(&mut g, &op(vec![change::Change::Task(task("t1", "x", 10 + (1 << 21), "d1"))])).is_err());
}

#[test]
fn invalid_change_is_skipped_but_others_apply() {
    let mut a = PlannerState::default();
    let bad = Task { id: "bad".into(), name: s("", 1, "d1"), ..Default::default() };
    let bad_minutes = Task { id: "m".into(), minutes: Some(U32 { stamp: st(1, "d1"), value: 3, unset: false }), ..Default::default() };
    let bad_day = Task { id: "d".into(), day: s("вчера", 1, "d1"), ..Default::default() };
    let good = task("ok", "ok", 1, "d1");
    let applied = a
        .apply_op(&op(vec![change::Change::Task(bad), change::Change::Task(bad_minutes), change::Change::Task(bad_day), change::Change::Task(good)]), "d1")
        .unwrap();
    assert_eq!(applied, 1);
    assert_eq!(a.tasks.keys().collect::<Vec<_>>(), vec!["ok"]);

    // Настройки: конец дня раньше начала — отказ; перерыв вне окон — отказ.
    let bad_settings = Settings { stamp: st(2, "d1"), day_start: 1260, day_end: 540, lunch_start: 0, lunch_end: 0, margin: 15, budget: 600 };
    assert_eq!(a.apply_op(&op(vec![change::Change::Settings(bad_settings)]), "d1").unwrap(), 0);
    let ok_settings = Settings { stamp: st(2, "d1"), day_start: 480, day_end: 1200, lunch_start: 0, lunch_end: 0, margin: 10, budget: 480 };
    assert_eq!(a.apply_op(&op(vec![change::Change::Settings(ok_settings)]), "d1").unwrap(), 1);
    assert_eq!(a.settings.as_ref().unwrap().day_start, 480);
    let bad_goal = GoalSet { stamp: st(3, "d1"), kcal: Some(Goal { target: 100, tolerance: 200, set: false }), ..Default::default() };
    assert_eq!(a.apply_op(&op(vec![change::Change::Goals(bad_goal)]), "d1").unwrap(), 0);
}

#[test]
fn nutrition_entries_merge_whole_and_day_fields_by_stamp() {
    let entry = |id: &str, name: &str, l: u64, dev: &str| FoodEntry {
        id: id.into(),
        stamp: st(l, dev),
        name: name.into(),
        meal: "lunch".into(),
        kcal: 500.0,
        known: 1,
        ..Default::default()
    };
    let day1 = NutritionDay {
        day: "2026-10-08".into(),
        entries: vec![entry("e1", "суп", 1, "d1")],
        is_complete: Some(Bool { stamp: st(1, "d1"), value: false }),
        ..Default::default()
    };
    let day2 = NutritionDay {
        day: "2026-10-08".into(),
        entries: vec![entry("e1", "борщ", 2, "d2"), entry("e2", "хлеб", 2, "d2")],
        is_complete: Some(Bool { stamp: st(2, "d2"), value: true }),
        ..Default::default()
    };
    let mut a = PlannerState::default();
    a.apply_op(&op(vec![change::Change::NutritionDay(day1.clone())]), "d1").unwrap();
    a.apply_op(&op(vec![change::Change::NutritionDay(day2.clone())]), "d2").unwrap();
    let mut b = PlannerState::default();
    b.apply_op(&op(vec![change::Change::NutritionDay(day2)]), "d2").unwrap();
    b.apply_op(&op(vec![change::Change::NutritionDay(day1)]), "d1").unwrap();
    assert_eq!(snapshot_bytes(&a), snapshot_bytes(&b));
    let d = &a.nutrition["2026-10-08"];
    assert_eq!(d.entries.len(), 2);
    assert_eq!(d.entries.iter().find(|e| e.id == "e1").unwrap().name, "борщ");
    assert!(d.is_complete.as_ref().unwrap().value);
    // Удаление записи — надгробие; старая версия записи не воскрешает.
    let del = NutritionDay { day: "2026-10-08".into(), entries: vec![FoodEntry { id: "e2".into(), deleted: st(5, "d1"), ..Default::default() }], ..Default::default() };
    a.apply_op(&op(vec![change::Change::NutritionDay(del)]), "d1").unwrap();
    let e2 = a.nutrition["2026-10-08"].entries.iter().find(|e| e.id == "e2").unwrap();
    assert!(!PlannerState::is_entry_alive(e2));
}

#[test]
fn stamp_op_marks_every_present_register() {
    let mut o = op(vec![
        change::Change::Task(Task { id: "t".into(), name: Some(Str { stamp: None, value: "x".into() }), deleted: Some(LwwStamp::default()), ..Default::default() }),
        change::Change::Event(Event { id: "e".into(), start: Some(Str { stamp: None, value: "10:00".into() }), ..Default::default() }),
        change::Change::List(List { id: "l".into(), name: Some(Str { stamp: None, value: "Дом".into() }), ..Default::default() }),
    ]);
    planner::stamp_op(&mut o, &Stamp::new(9, "d1"));
    let stamps = planner::op_stamps(&o).unwrap();
    assert_eq!(stamps.len(), 4);
    assert!(stamps.iter().all(|s| s.lamport == 9 && s.device_id == "d1"));
    // spec 011: правило, экземпляры, источник и запись цели тоже получают метку.
    let mut o = op(vec![
        change::Change::Task(Task {
            id: "t".into(),
            repeat: Some(Repeat { kind: RepeatKind::Daily as i32, interval: 1, start_day: "2026-10-01".into(), ..Default::default() }),
            occurrences: vec![Occurrence { day: "2026-10-02".into(), done: true, ..Default::default() }, Occurrence { day: "2026-10-03".into(), excluded: true, ..Default::default() }],
            source: Some(parvane_protocol::pb::parvane::planner::v1::Source { chat: "bob@local".into(), op_id: "ab".into(), stamp: None }),
            ..Default::default()
        }),
        change::Change::GoalPeriod(GoalPeriod { id: "g".into(), start_day: "2026-10-01".into(), ..Default::default() }),
        change::Change::GoalPeriod(GoalPeriod { id: "h".into(), deleted: Some(LwwStamp::default()), ..Default::default() }),
    ]);
    planner::stamp_op(&mut o, &Stamp::new(10, "d1"));
    let stamps = planner::op_stamps(&o).unwrap();
    assert_eq!(stamps.len(), 6);
    assert!(stamps.iter().all(|s| s.lamport == 10 && s.device_id == "d1"));
    let mut st_ = PlannerState::default();
    assert_eq!(st_.apply_op(&o, "d1").unwrap(), 3);
}

#[test]
fn size_estimate_grows_with_data_and_year_of_food_fits() {
    let mut a = PlannerState::default();
    assert_eq!(a.size_estimate(), 0);
    // Год питания: 365 дней × 10 записей.
    for d in 0..365u32 {
        let day = format!("2026-{:02}-{:02}", d / 31 % 12 + 1, d % 28 + 1);
        let entries = (0..10)
            .map(|i| FoodEntry {
                id: format!("{day}-{i}"),
                stamp: st(1, "d1"),
                name: "Куриная грудка с рисом и овощами".into(),
                meal: "lunch".into(),
                kcal: 650.0,
                protein: 55.0,
                fat: 10.0,
                carbs: 80.0,
                known: 15,
                ..Default::default()
            })
            .collect();
        a.apply_op(&op(vec![change::Change::NutritionDay(NutritionDay { day, entries, ..Default::default() })]), "d1").unwrap();
    }
    let size = a.size_estimate();
    assert!(size > 100_000 && size < SNAPSHOT_WARN_BYTES, "год питания: {size} байт");
}

// ── property: порядок применения не влияет на снимок ────────────────────────

fn arb_change() -> impl Strategy<Value = (change::Change, String)> {
    let dev = prop::sample::select(vec!["d1".to_string(), "d2".to_string(), "d3".to_string()]);
    let id = prop::sample::select(vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    (dev, id, 1u64..40, 0u8..9, prop::option::of(1u64..40)).prop_map(|(dev, id, lamport, kind, del)| {
        let field = |v: &str| s(v, lamport, &dev);
        let change = match kind {
            0 => change::Change::Task(Task { id: id.clone(), name: field("имя"), ..Default::default() }),
            1 => change::Change::Task(Task { id: id.clone(), status: field("done"), minutes: Some(U32 { stamp: st(lamport, &dev), value: 30, unset: false }), ..Default::default() }),
            2 => change::Change::Task(Task { id: id.clone(), deleted: del.map(|l| LwwStamp { lamport: l, device_id: dev.clone() }).or(st(lamport, &dev)), ..Default::default() }),
            3 => change::Change::Event(Event { id: id.clone(), name: field("событие"), start: field("10:00"), end: field("11:00"), ..Default::default() }),
            4 => change::Change::List(List { id: id.clone(), name: field("список"), order: Some(I32 { stamp: st(lamport, &dev), value: lamport as i32 }), ..Default::default() }),
            5 => change::Change::Task(Task {
                id: id.clone(),
                repeat: Some(Repeat { stamp: st(lamport, &dev), kind: RepeatKind::Daily as i32, interval: 1 + (lamport % 3) as u32, start_day: "2026-10-01".into(), count: lamport as u32, ..Default::default() }),
                ..Default::default()
            }),
            6 => change::Change::Task(Task {
                id: id.clone(),
                occurrences: vec![Occurrence { day: format!("2026-10-{:02}", 1 + lamport % 5), stamp: st(lamport, &dev), done: lamport % 2 == 0, excluded: lamport % 3 == 0, done_steps: vec![] }],
                ..Default::default()
            }),
            7 => change::Change::GoalPeriod(GoalPeriod {
                id: id.clone(),
                stamp: del.is_none().then(|| LwwStamp { lamport, device_id: dev.clone() }),
                deleted: del.map(|l| LwwStamp { lamport: l, device_id: dev.clone() }),
                start_day: "2026-10-10".into(),
                kcal: Some(Goal { target: 1000 + lamport as u32, tolerance: 50, set: true }),
                ..Default::default()
            }),
            _ => change::Change::Settings(Settings { stamp: st(lamport, &dev), day_start: 540, day_end: 1260, lunch_start: 780, lunch_end: 840, margin: 15, budget: 600 + lamport as u32 }),
        };
        (change, dev)
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]
    #[test]
    fn merge_is_order_independent(changes in prop::collection::vec(arb_change(), 1..12), seed in any::<u64>()) {
        let apply_all = |order: &[usize]| {
            let mut st = PlannerState::default();
            for &i in order {
                let (c, dev) = &changes[i];
                st.apply_op(&op(vec![c.clone()]), dev).unwrap();
            }
            snapshot_bytes(&st)
        };
        let n = changes.len();
        let forward: Vec<usize> = (0..n).collect();
        let mut shuffled = forward.clone();
        // Простая детерминированная перестановка от seed.
        let mut x = seed;
        for i in (1..n).rev() {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let j = (x >> 33) as usize % (i + 1);
            shuffled.swap(i, j);
        }
        prop_assert_eq!(apply_all(&forward), apply_all(&shuffled));
        // Идемпотентность: дважды — то же самое.
        let twice: Vec<usize> = forward.iter().chain(forward.iter()).copied().collect();
        prop_assert_eq!(apply_all(&forward), apply_all(&twice));
    }
}

#[test]
fn five_thousand_ops_apply_and_snapshot_fast() {
    // US4 (T029): чистое устройство проигрывает длинную историю быстро.
    let mut st = PlannerState::default();
    let started = std::time::Instant::now();
    for i in 0..5000u64 {
        let id = format!("t{}", i % 500);
        let t = Task { id: id.clone(), name: s(&format!("Задача {i}"), i + 1, "d1"), status: s(if i % 7 == 0 { "done" } else { "queue" }, i + 1, "d1"), ..Default::default() };
        st.apply_op(&op(vec![change::Change::Task(t)]), "d1").unwrap();
    }
    let snapshot = st.to_snapshot();
    let bytes = snapshot.encode_to_vec();
    let restored = PlannerState::from_snapshot(&snapshot).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(restored.tasks.len(), 500);
    assert!(bytes.len() < SNAPSHOT_WARN_BYTES, "снимок {} байт", bytes.len());
    assert!(elapsed.as_secs_f64() < 1.0, "5000 операций и снимок заняли {elapsed:?}");
}
