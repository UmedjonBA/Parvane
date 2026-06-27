// CALENDAR screen.

const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEK_HEAD = ["Mo","Tu","We","Th","Fr","Sa","Su"];
const WEEK_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const WEEK_KEYS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function fmtDate(d) {
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}


function catColor(cat) {
  return { work: "blue", personal: "green", deadline: "red", system: "purple" }[cat] || "muted";
}

function DeadlinesPanel() {
  return (
    <Panel title="UPCOMING DEADLINES" sub={MONO_DATA.deadlines.length + " items"}>
      <div className="rowlist deadlines">
        {MONO_DATA.deadlines.map((d, i) => (
          <div className="row" key={i}>
            <span style={{
              width: 56,
              color: d.color === "red" ? "var(--red)" :
                     d.color === "yellow" ? "var(--yellow)" : "var(--muted)",
              fontWeight: d.label === "TODAY" ? 700 : 400
            }}>{d.label}</span>
            <span>{d.title}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function SchedulePanel({ date }) {
  const dayKey = WEEK_NAMES[date.getDay()];
  const items = MONO_DATA.schedule[dayKey] || [];
  return (
    <Panel title="SCHEDULE" sub={["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][date.getDay()]}>
      {items.length === 0 ? (
        <div className="muted">No classes scheduled</div>
      ) : (
        <div className="rowlist schedule-list">
          {items.map((it, i) => (
            <div key={i} className={"schedule-item" + (it.current ? " current" : "")}>
              <div className="sched-time-row">
                <span className="cur-marker">{it.current ? "▶" : " "}</span>
                <span className="strong">{it.range}</span>
                <span style={{ marginLeft: 8 }}>
                  {it.tags.map(t => <Badge key={t} kind={t}>{t}</Badge>)}
                </span>
              </div>
              <div className="sched-title strong">{it.title}</div>
              <div className="sched-room muted">@ {it.room}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function DayPulse({ date, eventMap, liveAvail }) {
  const ds     = fmtDate(date);
  const evMap  = eventMap || {};
  const events = evMap[ds] || [];
  const dayKey = WEEK_NAMES[date.getDay()];
  const sched  = liveAvail ? [] : (MONO_DATA.schedule[dayKey] || []);
  const hours = [];
  for (let h = 7; h <= 23; h++) {
    let kind = null;
    sched.forEach(s => {
      const [a, b] = s.range.split("-");
      const ha = parseInt(a.split(":")[0], 10), hb = parseInt(b.split(":")[0], 10);
      if (h >= ha && h < hb + (b.split(":")[1] !== "00" ? 1 : 0)) kind = "sched";
    });
    events.forEach(e => {
      const eh = parseInt(e.time.split(":")[0], 10);
      if (eh === h) kind = e.cat;
    });
    hours.push({ h, kind });
  }
  return (
    <Panel title="DAY PULSE" sub="07:00 → 23:00" className="day-pulse">
      <div className="pulse-grid">
        {hours.map(({h, kind}) => (
          <div key={h} className="pulse-cell" title={`${h}:00`}>
            <div className={"pulse-bar pulse-" + (kind || "empty")} />
            <div className="pulse-hour muted">{h}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// Конвертер живого события (LWW-Map snapshot) в формат, ожидаемый UI.
function liveEvToDisplay(ev) {
  const f = (k) => (ev.fields[k] && ev.fields[k].value) || "";
  const start = f("start");
  const hhmm  = start ? new Date(parseInt(start, 10) * 1000).toTimeString().slice(0, 5) : "00:00";
  return {
    event_id: ev.event_id,
    title:    f("title") || "Без названия",
    time:     hhmm,
    cat:      f("category") || "personal",
    location: f("location") || "",
    start:    start,
    end:      f("end"),
    isLive:   true,
  };
}

function CalendarScreen({ me }) {
  const liveAvail = window.PARVANE.available;
  const liveCalendar = liveAvail ? window.useLiveCalendar() : null;

  const [date, setDate]     = useState(new Date());
  const [selEvent, setSelEvent] = useState(null);
  const [detail, setDetail] = useState(false);

  // Строим eventMap из живых событий: { "YYYY-MM-DD": [event, ...] }
  const liveEventMap = {};
  if (liveAvail && liveCalendar) {
    liveCalendar.events.forEach((ev) => {
      const start = ev.fields["start"] && ev.fields["start"].value;
      if (!start) return;
      const ds = new Date(parseInt(start, 10) * 1000).toISOString().slice(0, 10);
      if (!liveEventMap[ds]) liveEventMap[ds] = [];
      liveEventMap[ds].push(liveEvToDisplay(ev));
    });
  }

  // В Tauri — только реальные события (даже если пусто); в браузере — моки
  const eventMap = liveAvail ? liveEventMap : MONO_DATA.events;

  const getEventsForDate = (d) => {
    const ds = fmtDate(d);
    return eventMap[ds] || [];
  };

  const selEvents  = getEventsForDate(date);
  const selEventObj = selEvent !== null ? selEvents[selEvent] : null;

  const handleDelete = async (ev) => {
    if (!liveAvail || !ev?.isLive) return;
    if (!confirm("Удалить событие «" + ev.title + "»?")) return;
    try {
      await liveCalendar.remove(ev.event_id);
      setSelEvent(null);
      setDetail(false);
    } catch (e) {
      console.error("[cal] delete:", e);
    }
  };

  return (
    <div className="cal-screen">
      <div className="cal-left col">
        <MiniCalendarLive selected={date} onSelect={setDate} eventMap={eventMap} />
        <EventsListLive
          date={date}
          events={selEvents}
          selectedIdx={selEvent}
          onSelect={setSelEvent}
          onOpen={() => setDetail(true)}
          onAdd={() => { setDetail("add"); setSelEvent(null); }}
        />
        {!liveAvail && <DeadlinesPanel />}
      </div>
      <div className="cal-mid col">
        {!liveAvail && <SchedulePanel date={date} />}
        <DayPulse date={date} eventMap={eventMap} liveAvail={liveAvail} />
      </div>
      <div className="cal-right col">
        {detail === "add"
          ? <AddEventPanel
              onClose={() => setDetail(false)}
              date={date}
              liveCalendar={liveCalendar}
            />
          : <EventDetailsLive
              date={date}
              event={selEventObj}
              idx={selEvent}
              total={selEvents.length}
              onClose={() => setDetail(false)}
              onDelete={() => handleDelete(selEventObj)}
            />}
        <WeekAhead today={date} onPick={setDate} eventMap={eventMap} liveAvail={liveAvail} />
      </div>
    </div>
  );
}

function MiniCalendarLive({ selected, onSelect, eventMap }) {
  const year  = selected.getFullYear();
  const month = selected.getMonth();
  const first = new Date(year, month, 1);
  const days  = new Date(year, month + 1, 0).getDate();
  let lead = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();

  return (
    <Panel title={`${MONTHS_FULL[month].toUpperCase()} ${year}`} sub={MONTHS_FULL[month] + " " + year} className="mini-cal">
      <div className="cal-grid">
        {WEEK_HEAD.map((w) => <div key={w} className="cal-cell head muted">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="cal-cell empty" />;
          const date  = new Date(year, month, d);
          const ds    = fmtDate(date);
          const has   = (eventMap[ds] || []).length > 0;
          const isSel = date.toDateString() === selected.toDateString();
          const isToday = date.toDateString() === today.toDateString();
          return (
            <button
              key={i}
              className={"cal-cell" + (isSel ? " sel" : "") + (isToday ? " today" : "") + (has ? " has" : "")}
              onClick={() => onSelect(date)}
            >
              {d}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function EventsListLive({ date, events, selectedIdx, onSelect, onOpen, onAdd }) {
  const day = date.getDate();
  const m   = MONTHS_FULL[date.getMonth()].slice(0, 3);
  return (
    <Panel
      title={`СОБЫТИЯ: ${day} ${m}`}
      sub={events.length ? `${events.length} событий` : ""}
      hint="↑↓ select  [d] del  [a] add"
    >
      {events.length === 0 ? (
        <div className="muted" style={{ paddingTop: 4 }}>Нет событий</div>
      ) : (
        <div className="rowlist">
          {events.map((e, i) => (
            <div
              key={e.event_id || i}
              className={"row" + (i === selectedIdx ? " selected" : "")}
              onClick={() => onSelect(i)}
              onDoubleClick={() => onOpen(i)}
            >
              <span className="marker">▶</span>
              <span className="strong" style={{ width: 56 }}>{e.time}</span>
              <Dot color={catColor(e.cat)} />
              <span>{e.title}</span>
            </div>
          ))}
        </div>
      )}
      <div className="hr" />
      <button className="btn" onClick={onAdd} style={{ marginTop: 2 }}>
        <span className="kbd">[a]</span> добавить
      </button>
    </Panel>
  );
}

function EventDetailsLive({ date, event, idx, total, onClose, onDelete }) {
  if (!event) return (
    <Panel title="СОБЫТИЕ" sub="—">
      <div className="muted">Нет выбранного события</div>
    </Panel>
  );
  const ds = fmtDate(date);
  return (
    <Panel title="СОБЫТИЕ" sub={`#${(idx||0)+1} из ${total}`} hint="[d] удалить  [Esc] закрыть" focused>
      <div className="form-row"><label>Название</label><span className="v">{event.title}</span></div>
      <div className="form-row"><label>Дата</label><span className="v">{ds}</span></div>
      <div className="form-row"><label>Время</label><span className="v">{event.time}</span></div>
      <div className="form-row"><label>Категория</label>
        <span className="v"><Dot color={catColor(event.cat)} /> {event.cat}</span>
      </div>
      {event.location && <div className="form-row"><label>Место</label><span className="v">{event.location}</span></div>}
      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        {event.isLive && <button className="btn danger" onClick={onDelete}>[d] удалить</button>}
        <button className="btn" onClick={onClose}>[Esc] закрыть</button>
      </div>
    </Panel>
  );
}

function AddEventPanel({ onClose, date, liveCalendar }) {
  const [title, setTitle]   = useState("");
  const [time, setTime]     = useState("18:00");
  const [loc, setLoc]       = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const submit = async () => {
    const t = title.trim();
    if (!t) { setError("введите название"); return; }
    setSaving(true);
    setError(null);
    try {
      if (liveCalendar) {
        // Вычисляем unix timestamp из выбранной даты + времени
        const [hh, mm] = time.split(":").map(Number);
        const startDate = new Date(date);
        startDate.setHours(hh, mm, 0, 0);
        const startTs = Math.floor(startDate.getTime() / 1000);
        const endTs   = startTs + 3600; // 1 час по умолчанию
        await liveCalendar.create(t, startTs, endTs, loc || undefined);
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="НОВОЕ СОБЫТИЕ" sub="create" hint="[Enter] создать  [Esc] отмена" focused>
      <div className="form-row"><label>Название</label>
        <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="…" onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
      </div>
      <div className="form-row"><label>Дата</label><span className="v">{fmtDate(date)}</span></div>
      <div className="form-row"><label>Время</label>
        <input className="form-input" value={time} onChange={(e) => setTime(e.target.value)} placeholder="ЧЧ:ММ" />
      </div>
      <div className="form-row"><label>Место</label>
        <input className="form-input" value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="@ …" />
      </div>
      {error && <div style={{ color: "var(--red)", fontSize: 12 }}>✗ {error}</div>}
      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={submit} disabled={saving}>{saving ? "создаю…" : "[Enter] создать"}</button>
        <button className="btn" onClick={onClose}>[Esc] отмена</button>
      </div>
    </Panel>
  );
}

function WeekAhead({ today, onPick, eventMap, liveAvail }) {
  const evMap = eventMap || {};
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }
  return (
    <Panel title="НЕДЕЛЯ" sub="7 дней">
      <div className="week-ahead">
        {days.map((d, i) => {
          const dk = WEEK_NAMES[d.getDay()];
          const ev = (evMap[fmtDate(d)] || []);
          const sc = liveAvail ? [] : (MONO_DATA.schedule[dk] || []);
          const totalDots = ev.length + sc.length;
          return (
            <div key={i} className="week-ahead-row" onClick={() => onPick(d)}>
              <span className="muted" style={{ width: 36 }}>{["Mo","Tu","We","Th","Fr","Sa","Su"][(d.getDay()+6)%7]}</span>
              <span className="strong" style={{ width: 28 }}>{d.getDate()}</span>
              <span className="dots-line">
                {sc.map((s, j) => <Dot key={"s"+j} color={badgeDotColor(s.tags[0])} />)}
                {ev.map((e, j) => <Dot key={"e"+j} color={catColor(e.cat)} />)}
              </span>
              <span className="muted" style={{ marginLeft: "auto" }}>{totalDots ? totalDots + " " : ""}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function badgeDotColor(tag) {
  if (!tag) return "muted";
  return {
    Lecture: "green", Seminar: "aqua", Lab: "purple",
    Math: "red", DM: "orange", ATP: "yellow", FL: "blue",
    Practic: "purple", Sport: "red",
  }[tag] || "muted";
}

window.CalendarScreen = CalendarScreen;
