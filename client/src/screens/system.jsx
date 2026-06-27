// SYSTEM screen — nodes, logs, command bar.

function SystemScreen() {
  const [focus, setFocus] = useState("nodes"); // nodes | logs
  const [nodeSel, setNodeSel] = useState(0);
  const [cmd, setCmd] = useState(":");
  const [filter, setFilter] = useState("ALL");

  const filteredLogs = MONO_DATA.logs.filter(l => filter === "ALL" || l.lvl === filter);

  return (
    <div className="sys-screen">
      <div className="sys-left col">
        <Panel
          title="NODES"
          sub="4 · grid"
          hint={focus === "nodes" ? "←↑↓→ navigate  [Enter] ping" : ""}
          focused={focus === "nodes"}
          onClick={() => setFocus("nodes")}
        >
          <div className="node-grid">
            {MONO_DATA.nodes.map((n, i) => (
              <button
                key={n.id}
                className={"node-card" + (i === nodeSel && focus === "nodes" ? " sel" : "")}
                onClick={() => { setFocus("nodes"); setNodeSel(i); }}
              >
                <div className="node-head">
                  <span className="strong">{n.id}</span>
                  <span className={"node-status " + n.status}>
                    <Dot color={n.status === "online" ? "green" : n.status === "offline" ? "red" : "yellow"} />
                    <span>{n.status.toUpperCase()}</span>
                  </span>
                </div>
                <div className="node-meta">
                  <span className="muted">ping</span>
                  <span className="strong">{n.ping !== null ? n.ping + " ms" : "—"}</span>
                </div>
                <div className="node-meta">
                  <span className="muted">uptime</span>
                  <span className="strong">{n.uptime}</span>
                </div>
                <div className="node-spark">
                  <NodeSpark online={n.status === "online"} />
                </div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="HUB METRICS" sub="last 5m">
          <div className="metrics-grid">
            <Metric label="rx" value="3.4 KB" sub="/s" color="aqua" />
            <Metric label="tx" value="46 KB"  sub="/s" color="orange" />
            <Metric label="msg/s" value="12.4" sub="" color="yellow" />
            <Metric label="err/min" value="0" sub="" color="green" />
            <Metric label="drift" value="±2 ms" sub="" color="muted" />
            <Metric label="re-conn" value="0" sub="/h" color="green" />
          </div>
          <div className="hr" />
          <div className="ascii dim" style={{ fontSize: 11, lineHeight: 1.1 }}>
{`rx ▁▂▂▃▃▄▄▅▆▅▄▃▂▃▃▄▅▆▇▆▅▄▃▂▁
tx ▁▁▂▃▂▂▂▃▃▄▅▆▅▄▄▃▃▂▂▃▄▅▅▄▃`}
          </div>
        </Panel>
      </div>

      <div className="sys-right col">
        <Panel
          title="RECENT LOGS"
          sub={`${filteredLogs.length} of ${MONO_DATA.logs.length}`}
          hint={focus === "logs" ? "↑↓ scroll  Tab switch" : ""}
          focused={focus === "logs"}
          onClick={() => setFocus("logs")}
        >
          <div className="log-filter">
            <span className="muted">filter:</span>
            {["ALL","MSG","INFO","WARN","ERR"].map(f => (
              <button key={f} className={"filter-pill" + (f === filter ? " on" : "")}
                onClick={() => setFilter(f)}>{f}</button>
            ))}
            <button className="btn" style={{ marginLeft: "auto" }}>[/] search</button>
          </div>
          <div className="hr" />
          <div className="log-list">
            {filteredLogs.map((l, i) => (
              <div key={i} className="log-row">
                <span className="log-t muted">{l.t}</span>
                <span className={"log-lvl lvl-" + l.lvl.toLowerCase()}>{l.lvl.padEnd(4," ")}</span>
                <span className="log-src">{l.src.padEnd(9," ")}</span>
                <span className="log-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="COMMAND" sub="TO:VERB:NOUN[:ARG]" hint="[Enter] send  [Esc] cancel">
          <div className="cmd-line">
            <span className="cmd-prompt">:</span>
            <input
              className="form-input cmd-input"
              value={cmd.slice(1)}
              onChange={e => setCmd(":" + e.target.value)}
              placeholder="VERTEX:GET:LAMP:STATE"
            />
            <span className="cmd-cursor">▌</span>
          </div>
          <div className="cmd-help">
            <span className="muted">recent:</span>
            {["VERTEX:GET:LAMP:STATE", "ACHTUNG:GET:LIST", "UKAZ:PRINT:STATUS"].map(c => (
              <button key={c} className="filter-pill" onClick={() => setCmd(":" + c)}>{c}</button>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function NodeSpark({ online }) {
  // simple ascii sparkline. red for offline.
  const txt = online ? "▂▃▃▂▂▃▄▃▂▂▃▄▅▄▃▂▂▃▃▂" : "▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁";
  return (
    <pre className="ascii" style={{ color: online ? "var(--green)" : "var(--red)", margin: 0, fontSize: 11 }}>
      {txt}
    </pre>
  );
}

function Metric({ label, value, sub, color }) {
  const c = `var(--${color})`;
  return (
    <div className="metric-cell">
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ color: c, fontWeight: 700, fontSize: 16 }}>
        {value}<span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{sub}</span>
      </div>
    </div>
  );
}

window.SystemScreen = SystemScreen;
