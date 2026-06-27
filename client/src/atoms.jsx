// Shared TUI atoms.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// Textarea с собственной историей undo/redo. Нативная отмена в управляемом
// React-textarea ломается (React переустанавливает .value и стирает стек
// браузера), поэтому ведём свой стек. Ctrl+Z — отмена, Ctrl+Shift+Z / Ctrl+Y —
// повтор, Ctrl+S — onSaveNow. Историю сбрасываем через key (по id заметки).
function UndoTextarea({ value, onChange, onSaveNow, onKeyDown: extKeyDown, ...rest }) {
  const ref  = useRef(null);
  const hist = useRef(null);
  if (hist.current === null) hist.current = { stack: [value || ""], idx: 0, t: 0 };

  const apply = (text) => {
    onChange(text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); const p = text.length; el.setSelectionRange(p, p); }
    });
  };

  const handleChange = (e) => {
    const next = e.target.value;
    const h = hist.current;
    const now = Date.now();
    const atEnd = h.idx === h.stack.length - 1;
    // близкие по времени правки сливаем в один шаг отмены
    if (atEnd && now - h.t < 500) {
      h.stack[h.idx] = next;
    } else {
      h.stack = h.stack.slice(0, h.idx + 1);
      h.stack.push(next);
      h.idx = h.stack.length - 1;
    }
    h.t = now;
    onChange(next);
  };

  const onKeyDown = (e) => {
    // e.code — физическая клавиша, не зависит от раскладки (рус/англ).
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === "KeyS") { e.preventDefault(); onSaveNow && onSaveNow(); return; }
    if (mod && !e.shiftKey && e.code === "KeyZ") {
      e.preventDefault();
      const h = hist.current;
      if (h.idx > 0) { h.idx -= 1; h.t = 0; apply(h.stack[h.idx]); }
      return;
    }
    if (mod && ((e.shiftKey && e.code === "KeyZ") || e.code === "KeyY")) {
      e.preventDefault();
      const h = hist.current;
      if (h.idx < h.stack.length - 1) { h.idx += 1; h.t = 0; apply(h.stack[h.idx]); }
      return;
    }
    if (extKeyDown) extKeyDown(e);
  };

  return <textarea ref={ref} value={value} onChange={handleChange} onKeyDown={onKeyDown} {...rest} />;
}

function Panel({ title, sub, hint, focused, dim, className, style, children, onClick }) {
  return (
    <div
      className={`panel${focused ? " focused" : ""}${dim ? " dim" : ""}${className ? " " + className : ""}`}
      style={style}
      onClick={onClick}
    >
      <div className="panel-title">
        <span>{title}</span>
        {sub && <span className="sub">{sub}</span>}
      </div>
      {hint && <div className="panel-hint">{hint}</div>}
      {children}
    </div>
  );
}

function Dot({ color = "muted", hollow }) {
  return <span className={`dot ${color}${hollow ? " hollow" : ""}`} />;
}

function Badge({ kind, children }) {
  return <span className={`badge ${kind ? kind.toLowerCase() : ""}`}>{children}</span>;
}

function HubStatus({ online = true, up = false, down = false }) {
  return (
    <div className="hud-box">
      <div className="hub-line">
        <Dot color={online ? "green" : "red"} />
        <span style={{ color: online ? "var(--green)" : "var(--red)", fontWeight: 700, letterSpacing: "0.08em" }}>
          {online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>
      <div className="hub-line" style={{ marginTop: 2 }}>
        <span className="hub-arrows">
          <span className={"up " + (up ? "active" : "")}>▲</span>
          <span className={"down " + (down ? "active" : "")}>▼</span>
        </span>
        <span className="muted" style={{ fontSize: 12 }}>HUB</span>
      </div>
    </div>
  );
}

function ClockBox({ time, date }) {
  return (
    <div className="hud-box">
      <div className="clock">{time}</div>
      <div className="date">{date}</div>
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(n => new Date(n.getTime() + 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = n => String(n).padStart(2, "0");
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  return { now, time: t, date: d };
}

// MONOLITH logo — drawn from box characters to mirror the screenshot.
function MonolithLogo({ color = "var(--orange)" }) {
  const art =
`███╗   ███╗   ██████╗   ███╗   ██╗   ██████╗   ██╗      ██╗   ████████╗   ██╗  ██╗
████╗ ████║  ██╔═══██╗  ████╗  ██║  ██╔═══██╗  ██║      ██║   ╚══██╔══╝   ██║  ██║
██╔████╔██║  ██║   ██║  ██╔██╗ ██║  ██║   ██║  ██║      ██║      ██║      ████████║
██║╚██╔╝██║  ██║   ██║  ██║╚██╗██║  ██║   ██║  ██║      ██║      ██║      ██╔═══██║
██║ ╚═╝ ██║  ╚██████╔╝  ██║ ╚████║  ╚██████╔╝  ███████╗ ██║      ██║      ██║   ██║
╚═╝     ╚═╝   ╚═════╝   ╚═╝  ╚═══╝   ╚═════╝   ╚══════╝ ╚═╝      ╚═╝      ╚═╝   ╚═╝`;
  return (
    <pre className="logo ascii" style={{ color, margin: 0, fontSize: 9, lineHeight: 1.05 }}>{art}</pre>
  );
}

function Footer({ hints, focus }) {
  return (
    <div className="footer">
      {hints.map((h, i) => (
        <span key={i}>
          <span className="key">{h[0]}</span>{" "}{h[1]}
        </span>
      ))}
      {focus && <span className="focus-info">{focus}</span>}
    </div>
  );
}

function Tabs({ active, onChange }) {
  const tabs = [
    { id: "calendar",  num: 1, label: "CALENDAR"  },
    { id: "_sep" },
    { id: "messenger", num: 2, label: "MESSENGER", accent: true },
    { id: "notes",     num: 3, label: "DIARY",     accent: true },
  ];
  return (
    <div className="tabs">
      {tabs.map(t => t.id === "_sep" ? (
        <div className="tab-sep" key="sep" />
      ) : (
        <button
          key={t.id}
          className={"tab" + (active === t.id ? " active" : "") + (t.accent ? " accent" : "")}
          onClick={() => onChange(t.id)}
        >
          <span className="k">[{t.num}]</span>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

Object.assign(window, {
  Panel, Dot, Badge, HubStatus, ClockBox, useClock, MonolithLogo, Footer, Tabs, UndoTextarea,
});
