// Shared TUI atoms.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

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
  const [now, setNow] = useState(new Date(2026, 4, 13, 23, 36, 16));
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
    { id: "diary",     num: 2, label: "DIARY"     },
    { id: "home",      num: 3, label: "HOME"      },
    { id: "system",    num: 4, label: "SYSTEM"    },
    { id: "_sep" },
    { id: "messenger", num: 5, label: "MESSENGER", accent: true },
    { id: "notes",     num: 6, label: "NOTES",     accent: true },
    { id: "cloud",     num: 7, label: "CLOUD",     accent: true },
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
  Panel, Dot, Badge, HubStatus, ClockBox, useClock, MonolithLogo, Footer, Tabs,
});
