// MONOLITH root.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#fe8019",
  "density": "comfortable",
  "logo": "block",
  "showFire": false
}/*EDITMODE-END*/;

function App() {
  const [tab, setTab] = useState("calendar");
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", t.accent);
    document.body.dataset.density = t.density;
  }, [t.accent, t.density]);

  // global keyboard: 1..7 switch
  useEffect(() => {
    const onKey = e => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const map = { "1":"calendar","2":"diary","3":"home","4":"system","5":"messenger","6":"notes","7":"cloud" };
      if (map[e.key]) setTab(map[e.key]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const screen = {
    calendar:  <CalendarScreen />,
    diary:     <DiaryScreen />,
    home:      <HomeScreen />,
    system:    <SystemScreen />,
    messenger: <MessengerScreen />,
    notes:     <NotesScreen />,
    cloud:     <CloudScreen />,
  }[tab];

  const footer = {
    calendar:  <Footer hints={[["↑↓","week"],["←→","day"],["[Enter]","select day"],["[a]","add"],["[1-7]","tabs"],["[q]","quit"]]} focus="CALENDAR · 13 May 2026" />,
    diary:     <Footer hints={[["↑↓","entry"],["[n]","new"],["[t]","timeline"],["[1-7]","tabs"],["[q]","quit"]]} focus="DIARY · 5 entries" />,
    home:      <Footer hints={[["[tab]","panel"],["↑↓","device"],["[Enter]","toggle"],["←/→","adjust"],["[1-7]","tabs"],["[q]","quit"]]} focus="HOME · VERTEX focused" />,
    system:    <Footer hints={[["[tab]","focus"],["←↑↓→","nodes"],["[Enter]","ping"],["[:]","cmd"],["[1-7]","tabs"],["[q]","quit"]]} focus="SYSTEM · 4 nodes · hub OK" />,
    messenger: <Footer hints={[["↑↓","chat"],["[/]","search"],["[Enter]","send"],["[r]","reply"],["[1-7]","tabs"],["[q]","quit"]]} focus="MESSENGER · 8 chats · 16 unread" />,
    notes:     <Footer hints={[["↑↓","note"],["[Enter]","open"],["[Ctrl+P]","palette"],["[g]","graph"],["[1-7]","tabs"],["[q]","quit"]]} focus="NOTES · vault://monolith · 42 notes" />,
    cloud:     <Footer hints={[["↑↓","entry"],["[Enter]","open"],["[Space]","mark"],["[d]","delete"],["[/]","search"],["[1-7]","tabs"],["[q]","quit"]]} focus="CLOUD · 906/2804 GB · 3014 shards" />,
  }[tab];

  return (
    <>
      <Shell active={tab} onTab={setTab} footer={footer} tweaks={t}>
        {screen}
      </Shell>
      {t.showFire && <FireAlert onClose={() => setTweak("showFire", false)} />}
      <TweaksPanel title="MONOLITH · Tweaks">
        <TweakSection title="Visual">
          <TweakColor t={t} setTweak={setTweak} k="accent"
            options={["#fe8019","#fabd2f","#d3869b","#8ec07c","#83a598"]}>
            Accent (new tabs)
          </TweakColor>
          <TweakRadio t={t} setTweak={setTweak} k="density"
            options={["compact","comfortable"]}>Density</TweakRadio>
          <TweakRadio t={t} setTweak={setTweak} k="logo"
            options={["block","line"]}>Logo style</TweakRadio>
        </TweakSection>
        <TweakSection title="Demo">
          <TweakToggle t={t} setTweak={setTweak} k="showFire">FIRE alert modal</TweakToggle>
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

function FireAlert({ onClose }) {
  return (
    <div className="fire-backdrop" onClick={onClose}>
      <div className="fire-modal" onClick={e => e.stopPropagation()}>
        <h2>⚠ ALARM</h2>
        <p>TIMER fired</p>
        <p className="fire-name">pomodoro_25</p>
        <div className="fire-action">[ Enter ] turn off buzzer</div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>VERTEX:BUZZ:ON</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
