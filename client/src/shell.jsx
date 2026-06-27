// App shell — header (logo + hub + clock), tabs, footer.

function Shell({ active, onTab, footer, tweaks, children }) {
  const { time, date } = useClock();
  const [pulse, setPulse] = useState({ up: false, down: false });
  // null = веб/моки (показываем ONLINE как раньше); bool = реальный статус NATS.
  const liveOnline = window.useLiveStatus();

  // tiny pulse animation on hub arrows
  useEffect(() => {
    const id = setInterval(() => {
      setPulse({ up: Math.random() < 0.45, down: Math.random() < 0.55 });
      setTimeout(() => setPulse({ up: false, down: false }), 220);
    }, 1800);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <div className="header">
        <MonolithLogo color={tweaks.dark ? "var(--orange)" : "var(--orange)"} />
        <div className="hud">
          <HubStatus online={liveOnline !== false} up={pulse.up} down={pulse.down} />
          <ClockBox time={time} date={date} />
        </div>
      </div>
      <Tabs active={active} onChange={onTab} />
      <main>{children}</main>
      {footer}
    </div>
  );
}

window.Shell = Shell;
