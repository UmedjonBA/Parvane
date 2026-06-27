// HOME screen — VERTEX / UKAZ / ACHTUNG

function HomeScreen() {
  const [focus, setFocus] = useState("vertex"); // vertex | ukaz | achtung
  const [vertexSel, setVertexSel] = useState(0);
  const [ukazSel, setUkazSel] = useState(0);
  const [achSel, setAchSel] = useState(0);
  const [achForm, setAchForm] = useState(null); // null | "timer" | "alarm"

  const sel = focus === "vertex" ? vertexSel : focus === "ukaz" ? ukazSel : achSel;

  return (
    <div className="home-screen">
      <div className="home-left col">
        <Panel
          title="VERTEX"
          sub="devices · 6"
          hint={focus === "vertex" ? "↑↓ select  [Enter] toggle  ←/→ adjust" : ""}
          focused={focus === "vertex"}
          onClick={() => setFocus("vertex")}
        >
          <div className="rowlist devices">
            {MONO_DATA.vertex.map((d, i) => (
              <div
                key={d.id}
                className={"row device-row" + (focus === "vertex" && i === vertexSel ? " selected" : "")}
                onClick={() => { setFocus("vertex"); setVertexSel(i); }}
              >
                <span className="marker">▌</span>
                <span className="dev-glyph">{deviceGlyph(d)}</span>
                <span className="dev-name strong">{d.name}</span>
                <span className="dev-topic dim">[{d.topic}]</span>
                <span className="dev-value">
                  {d.kind === "toggle" && <ToggleState s={d.state} />}
                  {d.kind === "cycle"  && <CycleState mode={d.state} all={d.modes} />}
                  {d.kind === "value"  && <ValueBar v={d.value} max={d.max} />}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="UKAZ"
          sub="print · 3"
          hint={focus === "ukaz" ? "↑↓ select  [Enter] trigger" : ""}
          focused={focus === "ukaz"}
          onClick={() => setFocus("ukaz")}
        >
          <div className="rowlist">
            {MONO_DATA.ukaz.map((u, i) => (
              <div
                key={u.id}
                className={"row" + (focus === "ukaz" && i === ukazSel ? " selected" : "")}
                onClick={() => { setFocus("ukaz"); setUkazSel(i); }}
              >
                <span className="marker">▶</span>
                <span style={{ color: "var(--green)" }}>▶</span>
                <span className="strong">{u.name}</span>
                <span className="muted" style={{ marginLeft: "auto" }}>[Enter] trigger</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="ACHTUNG"
          sub="timers & alarms · 4"
          hint={focus === "achtung" ? "↑↓ select  [t] timer  [a] alarm  [d] stop" : ""}
          focused={focus === "achtung"}
          onClick={() => setFocus("achtung")}
        >
          <div className="rowlist">
            {MONO_DATA.achtung.map((a, i) => (
              <div
                key={a.name}
                className={"row" + (focus === "achtung" && i === achSel ? " selected" : "")}
                onClick={() => { setFocus("achtung"); setAchSel(i); }}
              >
                <span className="marker">▌</span>
                <span className={"kind " + (a.kind === "ALARM" ? "kind-alarm" : "kind-timer")}>{a.kind}:</span>
                <span className="strong">{a.name}</span>
                <span className="muted">left:</span>
                <span style={{ color: "var(--yellow)", fontVariantNumeric: "tabular-nums" }}>{a.left}</span>
                {a.due && <><span className="muted">due:</span><span>{a.due}</span></>}
              </div>
            ))}
          </div>
          <div className="hr" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => { setFocus("achtung"); setAchForm("timer"); }}>[t] new timer</button>
            <button className="btn" onClick={() => { setFocus("achtung"); setAchForm("alarm"); }}>[a] new alarm</button>
            <button className="btn danger">[d] stop selected</button>
          </div>
        </Panel>
      </div>

      <div className="home-right col">
        {achForm ? (
          <AchForm kind={achForm} onClose={() => setAchForm(null)} />
        ) : focus === "achtung" ? (
          <AchDetails item={MONO_DATA.achtung[achSel]} />
        ) : focus === "vertex" ? (
          <DeviceDetails dev={MONO_DATA.vertex[vertexSel]} />
        ) : (
          <UkazDetails item={MONO_DATA.ukaz[ukazSel]} />
        )}
        <ScenePanel />
        <PowerPanel />
      </div>
    </div>
  );
}

function deviceGlyph(d) {
  if (d.kind === "toggle") return d.state === "on" ? "●" : "○";
  if (d.kind === "cycle")  return "◆";
  return "◇";
}

function ToggleState({ s }) {
  return (
    <span style={{ color: s === "on" ? "var(--green)" : s === "off" ? "var(--muted)" : "var(--yellow)" }}>
      {s === "on" ? "ON" : s === "off" ? "OFF" : "?"}
    </span>
  );
}

function CycleState({ mode, all }) {
  return (
    <span className="cycle-row">
      {all.map(m => (
        <span key={m} className={"cycle-pill " + (m === mode ? "on" : "")}>{m}</span>
      ))}
    </span>
  );
}

function ValueBar({ v, max }) {
  return (
    <span className="progress">
      <span className="bar"><i style={{ width: (v/max*100) + "%" }} /></span>
      <span className="strong">{v}</span>
      <span className="muted">/ {max}</span>
    </span>
  );
}

function DeviceDetails({ dev }) {
  if (!dev) return null;
  return (
    <Panel title="DEVICE" sub={dev.topic} focused>
      <div className="form-row"><label>Name</label><span className="v strong">{dev.name}</span></div>
      <div className="form-row"><label>Node</label><span className="v">VERTEX</span></div>
      <div className="form-row"><label>Topic</label><span className="v">{dev.topic}</span></div>
      <div className="form-row"><label>Kind</label><span className="v">{dev.kind}</span></div>
      <div className="form-row"><label>State</label>
        <span className="v">
          {dev.kind === "toggle" && <ToggleState s={dev.state} />}
          {dev.kind === "cycle"  && <span style={{ color: "var(--yellow)" }}>{String(dev.state).toUpperCase()}</span>}
          {dev.kind === "value"  && <span style={{ color: "var(--yellow)" }}>{dev.value} / {dev.max}</span>}
        </span>
      </div>
      <div className="hr" />
      <div className="form-row"><label>Last cmd</label><span className="v muted">23:36:48  OK</span></div>
      <div className="form-row"><label>Avg latency</label><span className="v muted">28 ms</span></div>
      <div className="form-row"><label>Events / 24h</label><span className="v muted">142</span></div>
    </Panel>
  );
}

function UkazDetails({ item }) {
  return (
    <Panel title="PRINT JOB" sub="ukaz" focused>
      <div className="form-row"><label>Action</label><span className="v strong">{item.name}</span></div>
      <div className="form-row"><label>Command</label><span className="v">{item.cmd}</span></div>
      <div className="form-row"><label>Last run</label><span className="v muted">13 May 23:14  (OK)</span></div>
      <div className="form-row"><label>Avg lines</label><span className="v muted">38</span></div>
      <div className="hr" />
      <button className="btn primary">[Enter] trigger now</button>
    </Panel>
  );
}

function AchDetails({ item }) {
  return (
    <Panel title={item.kind === "ALARM" ? "ALARM" : "TIMER"} sub={item.name} focused>
      <div className="form-row"><label>Name</label><span className="v strong">{item.name}</span></div>
      <div className="form-row"><label>Remaining</label><span className="v" style={{ color: "var(--yellow)" }}>{item.left}</span></div>
      {item.due && <div className="form-row"><label>Due</label><span className="v">{item.due}</span></div>}
      <div className="form-row"><label>On fire</label><span className="v">VERTEX:BUZZ:ON</span></div>
      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn danger">[d] stop</button>
        <button className="btn">[Esc] close</button>
      </div>
    </Panel>
  );
}

function AchForm({ kind, onClose }) {
  if (kind === "timer") {
    return (
      <Panel title="ADD TIMER" hint="[Enter] submit  [Esc] cancel" focused>
        <div className="form-row"><label>Duration</label>
          <input className="form-input" defaultValue="25m" placeholder="e.g. 5m, 1h" />
        </div>
        <div className="form-row"><label>Presets</label>
          <span>
            {["5m","10m","25m","1h"].map(p => <button key={p} className="btn" style={{ marginRight: 6 }}>{p}</button>)}
          </span>
        </div>
        <div className="form-row"><label>Name (opt)</label>
          <input className="form-input" defaultValue="" placeholder="pomodoro_25" />
        </div>
        <div className="hr" />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary">[Enter] submit</button>
          <button className="btn" onClick={onClose}>[Esc] cancel</button>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="ADD ALARM" hint="[Enter] submit  [Esc] cancel" focused>
      <div className="form-row"><label>Date</label><input className="form-input" defaultValue="2026-05-14" /></div>
      <div className="form-row"><label>Time</label><input className="form-input" defaultValue="20:00" /></div>
      <div className="form-row"><label>Quick</label>
        <span>
          {["today","tomorrow","evening"].map(p => <button key={p} className="btn" style={{ marginRight: 6 }}>{p}</button>)}
        </span>
      </div>
      <div className="form-row"><label>Name (opt)</label><input className="form-input" defaultValue="" placeholder="alarm_..." /></div>
      <div className="hr" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary">[Enter] submit</button>
        <button className="btn" onClick={onClose}>[Esc] cancel</button>
      </div>
    </Panel>
  );
}

function ScenePanel() {
  const scenes = [
    { name: "morning", glyph: "☀", on: false, desc: "lamp on, led solid 180, fan off" },
    { name: "focus",   glyph: "◉", on: true,  desc: "led fade 225, lamp on, buzz off" },
    { name: "night",   glyph: "☾", on: false, desc: "lamp off, led blink 12" },
    { name: "panic",   glyph: "⚠", on: false, desc: "buzz on, all lights on, fan max" },
  ];
  return (
    <Panel title="SCENES" sub="quick state">
      <div className="rowlist">
        {scenes.map(s => (
          <div key={s.name} className={"row scene-row" + (s.on ? " on" : "")}>
            <span className="marker">▌</span>
            <span className="scene-glyph">{s.glyph}</span>
            <span className="strong" style={{ width: 80 }}>{s.name}</span>
            <span className="muted">{s.desc}</span>
            {s.on && <span className="badge lecture" style={{ marginLeft: "auto" }}>ACTIVE</span>}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function PowerPanel() {
  return (
    <Panel title="POWER" sub="last 24h">
      <div className="power-grid">
        <div className="power-cell">
          <div className="muted">draw</div>
          <div className="strong" style={{ fontSize: 18 }}>42 W</div>
        </div>
        <div className="power-cell">
          <div className="muted">peak</div>
          <div className="strong" style={{ fontSize: 18 }}>118 W</div>
        </div>
        <div className="power-cell">
          <div className="muted">energy</div>
          <div className="strong" style={{ fontSize: 18 }}>0.91 kWh</div>
        </div>
        <div className="power-cell">
          <div className="muted">cost</div>
          <div className="strong" style={{ fontSize: 18 }}>4.50 ₽</div>
        </div>
      </div>
      <div className="hr" />
      <div className="ascii dim" style={{ fontSize: 11, lineHeight: 1.1 }}>
{`  ▁▂▂▁▂▃▅▆▅▄▃▂▂▃▅▇█▇▆▅▄▄▃▂
  00              12              23`}
      </div>
    </Panel>
  );
}

window.HomeScreen = HomeScreen;
