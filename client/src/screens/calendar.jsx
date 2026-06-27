// CALENDAR screen.

const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEK_HEAD = ["Mo","Tu","We","Th","Fr","Sa","Su"];
const WEEK_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const WEEK_KEYS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function fmtDate(d) {
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function MiniCalendar({ selected, onSelect }) {
  const year  = selected.getFullYear();
  const month = selected.getMonth();
  const first = new Date(year, month, 1);
  const days  = new Date(year, month+1, 0).getDate();
  // Monday-first index
  let lead = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date(2026, 4, 13);
  const eventMap = MONO_DATA.events;

  return (
    <Panel title="MAY 2026" sub={MONTHS_FULL[month] + " " + year} className="mini-cal">
      <div className="cal-grid">
        {WEEK_HEAD.map(w => <div key={w} className="cal-cell head muted">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="cal-cell empty" />;
          const date = new Date(year, month, d);
          const ds = fmtDate(date);
          const has = eventMap[ds];
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

function EventsList({ date, selectedIdx, onSelect, onOpen, onAdd }) {
  const ds = fmtDate(date);
  const list = MONO_DATA.events[ds] || [];
  const day = date.getDate();
  const m = MONTHS_FULL[date.getMonth()].slice(0,3);
  return (
    <Panel
      title={`EVENTS: ${day} ${m}`}
      sub={list.length ? `${list.length} entries` : ""}
      hint="↑↓ select  [d] del  [a] add"
    >
      {list.length === 0 ? (
        <div className="muted" style={{ paddingTop: 4 }}>No events scheduled</div>
      ) : (
        <div className="rowlist">
          {list.map((e, i) => (
            <div
              key={i}
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
        <span className="kbd">[a]</span> add event
      </button>
    </Panel>
  );
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

function DayPulse({ date }) {
  // little ascii day-bar showing hours; events appear as colored cells
  const ds = fmtDate(date);
  const events = MONO_DATA.events[ds] || [];
  const dayKey = WEEK_NAMES[date.getDay()];
  const sched = MONO_DATA.schedule[dayKey] || [];
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

function EventDetails({ date, idx, onClose }) {
  const ds = fmtDate(date);
  const list = MONO_DATA.events[ds] || [];
  const e = list[idx];
  if (!e) return (
    <Panel title="EVENT" sub="—">
      <div className="muted">No event selected</div>
    </Panel>
  );
  return (
    <Panel title="EVENT" sub={`#${idx+1} of ${list.length}`} hint="[d] delete  [Esc] close" focused>
      <div className="form-row"><label>Title</label><span className="v">{e.title}</span></div>
      <div className="form-row"><label>Date</label><span className="v">{ds}</span></div>
      <div className="form-row"><label>Time</label><span className="v">{e.time}</span></div>
      <div className="form-row"><label>Category</label>
        <span className="v"><Dot color={catColor(e.cat)} /> {e.cat}</span>
      </div>
      <div className="form-row"><label>Location</label><span className="v placeholder">—</span></div>
      <div className="form-row"><label>Notes</label><span className="v placeholder">—</span></div>
      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn danger">[d] delete</button>
        <button className="btn" onClick={onClose}>[Esc] close</button>
      </div>
    </Panel>
  );
}

function CalendarScreen() {
  const [date, setDate] = useState(new Date(2026, 4, 13));
  const [selEvent, setSelEvent] = useState(0);
  const [detail, setDetail] = useState(false);

  return (
    <div className="cal-screen">
      <div className="cal-left col">
        <MiniCalendar selected={date} onSelect={setDate} />
        <EventsList
          date={date}
          selectedIdx={selEvent}
          onSelect={setSelEvent}
          onOpen={() => setDetail(true)}
          onAdd={() => setDetail("add")}
        />
        <DeadlinesPanel />
      </div>
      <div className="cal-mid col">
        <SchedulePanel date={date} />
        <DayPulse date={date} />
      </div>
      <div className="cal-right col">
        {detail === "add"
          ? <AddEventPanel onClose={() => setDetail(false)} date={date} />
          : <EventDetails date={date} idx={selEvent} onClose={() => setDetail(false)} />}
        <WeekAhead today={date} onPick={setDate} />
      </div>
    </div>
  );
}

function AddEventPanel({ onClose, date }) {
  return (
    <Panel title="ADD EVENT" sub="new" hint="[Enter] submit  [Esc] cancel" focused>
      <div className="form-row"><label>Title</label><input className="form-input" defaultValue="" placeholder="..." /></div>
      <div className="form-row"><label>Date</label><input className="form-input" defaultValue={fmtDate(date)} /></div>
      <div className="form-row"><label>Time (HH:MM)</label><input className="form-input" defaultValue="18:00" /></div>
      <div className="form-row"><label>Location</label><input className="form-input" defaultValue="" placeholder="@ ..." /></div>
      <div className="form-row"><label>Notes</label>
        <textarea className="form-input" rows="3" defaultValue="" />
      </div>
      <div className="form-row"><label>Category</label>
        <span className="v">
          {["work","personal","deadline","system"].map(c => (
            <span key={c} style={{ marginRight: 10 }}><Dot color={catColor(c)} /> {c}</span>
          ))}
        </span>
      </div>
      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary">[Enter] submit</button>
        <button className="btn" onClick={onClose}>[Esc] cancel</button>
      </div>
    </Panel>
  );
}

function WeekAhead({ today, onPick }) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }
  return (
    <Panel title="WEEK AHEAD" sub="7 days">
      <div className="week-ahead">
        {days.map((d, i) => {
          const dk = WEEK_NAMES[d.getDay()];
          const ev = (MONO_DATA.events[fmtDate(d)] || []);
          const sc = MONO_DATA.schedule[dk] || [];
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
