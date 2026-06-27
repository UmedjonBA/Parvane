// SYSTEM screen — реальные метрики NATS + узлы.

// Хук для получения метрик NATS через HTTP-мониторинг на порту 8222.
// Tauri не поддерживает fetch к localhost напрямую — используем обходной путь
// через XMLHttpRequest с режимом "no-cors" не работает в десктопе так же.
// Поэтому используем fetch к /varz (NATS monitoring HTTP API).
function useNatsMetrics() {
  const [metrics, setMetrics] = useState(null);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const resp = await fetch("http://127.0.0.1:8222/varz");
        const data = await resp.json();
        if (alive) { setMetrics(data); setError(null); }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { metrics, error };
}

function fmtUptime(secs) {
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? h + "h " + m + "m" : m + "m";
}

function SystemScreen() {
  const [focus, setFocus]       = useState("nodes");
  const [nodeSel, setNodeSel]   = useState(0);
  const [cmd, setCmd]           = useState(":");
  const [filter, setFilter]     = useState("ALL");
  const { metrics, error: natsErr } = useNatsMetrics();

  const filteredLogs = MONO_DATA.logs.filter((l) => filter === "ALL" || l.lvl === filter);

  // Строим живой узел NATS если метрики доступны
  const liveNode = metrics ? {
    id:     "nats-hub",
    status: "online",
    ping:   null,
    uptime: fmtUptime(metrics.uptime),
    subs:   metrics.subscriptions || 0,
    msgs:   metrics.in_msgs || 0,
  } : null;

  const nodes = liveNode ? [liveNode, ...MONO_DATA.nodes.slice(1)] : MONO_DATA.nodes;

  return (
    <div className="sys-screen">
      <div className="sys-left col">
        <Panel
          title="УЗЛЫ"
          sub={nodes.length + " · grid"}
          hint={focus === "nodes" ? "←↑↓→ навигация  [Enter] ping" : ""}
          focused={focus === "nodes"}
          onClick={() => setFocus("nodes")}
        >
          <div className="node-grid">
            {nodes.map((n, i) => (
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
                {n.subs !== undefined && (
                  <div className="node-meta">
                    <span className="muted">subs</span>
                    <span className="strong" style={{ color: "var(--aqua)" }}>{n.subs}</span>
                  </div>
                )}
                <div className="node-spark">
                  <NodeSpark online={n.status === "online"} />
                </div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="HUB METRICS" sub={metrics ? "NATS live" : "last 5m"}>
          {natsErr && <div className="muted" style={{ fontSize: 11 }}>NATS мониторинг недоступен: {natsErr}</div>}
          <div className="metrics-grid">
            {metrics ? (
              <>
                <Metric label="in_msgs"  value={metrics.in_msgs}          sub=""    color="aqua"   />
                <Metric label="out_msgs" value={metrics.out_msgs}         sub=""    color="orange" />
                <Metric label="in_bytes" value={fmtBytes2(metrics.in_bytes)} sub="" color="yellow" />
                <Metric label="subs"     value={metrics.subscriptions}    sub=""    color="green"  />
                <Metric label="conns"    value={metrics.connections}      sub=""    color="blue"   />
                <Metric label="slow_con" value={metrics.slow_consumers || 0} sub="" color={metrics.slow_consumers > 0 ? "red" : "green"} />
              </>
            ) : (
              <>
                <Metric label="rx"      value="3.4 KB" sub="/s" color="aqua"   />
                <Metric label="tx"      value="46 KB"  sub="/s" color="orange" />
                <Metric label="msg/s"   value="12.4"   sub=""   color="yellow" />
                <Metric label="err/min" value="0"      sub=""   color="green"  />
                <Metric label="drift"   value="±2 ms"  sub=""   color="muted"  />
                <Metric label="re-conn" value="0"      sub="/h" color="green"  />
              </>
            )}
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

function fmtBytes2(n) {
  if (!n) return "0";
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + "G";
  if (n >= 1048576)    return (n / 1048576).toFixed(1) + "M";
  if (n >= 1024)       return (n / 1024).toFixed(0) + "K";
  return n + "B";
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
