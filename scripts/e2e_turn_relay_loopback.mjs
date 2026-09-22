// Реальный обмен данными через TURN-релей глазами WebRTC (Chromium): два
// RTCPeerConnection в одной странице, оба relay-only через один TURN, data channel
// ping/pong. Успех = «LOOPBACK OK» + выбранная пара кандидатов (оба relay).
// Доказывает не только аллокацию, но и путь данных через NAT в обе стороны.
//   TURN_URL=turn:host:port?transport=udp TURN_USER=... TURN_PASS=... node scripts/e2e_turn_relay_loopback.mjs
import { chromium } from 'playwright';
const url = process.env.TURN_URL, user = process.env.TURN_USER, pass = process.env.TURN_PASS;
if (!url || !user || !pass) { console.error('TURN_URL/TURN_USER/TURN_PASS required'); process.exit(2); }
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  const r = await page.evaluate(async ({ url2, user2, pass2, asym }) => {
    const cfg = { iceServers: [{ urls: [url2], username: user2, credential: pass2 }], iceTransportPolicy: 'relay' };
    // ASYM=1: B без TURN (host/srflx) — реальный случай «relay с одной стороны»; без hairpin на NAT сервера
    // B без TURN, но со STUN (тот же хост): нужен srflx, иначе у B только приватные host-кандидаты
    const cfgB = asym ? { iceServers: [{ urls: [url2.replace(/^turn:/, 'stun:').replace(/\?.*$/, '')] }] } : cfg;
    const a = new RTCPeerConnection(cfg), b = new RTCPeerConnection(cfgB);
    const cands = { a: [], b: [] };
    a.onicecandidate = (e) => { if (e.candidate) { cands.a.push(e.candidate.candidate); b.addIceCandidate(e.candidate); } };
    b.onicecandidate = (e) => { if (e.candidate) { cands.b.push(e.candidate.candidate); a.addIceCandidate(e.candidate); } };
    const dc = a.createDataChannel('probe');
    const result = new Promise((resolve) => {
      b.ondatachannel = (ev) => { ev.channel.onmessage = (m) => { ev.channel.send('pong:' + m.data); }; };
      dc.onmessage = (m) => resolve({ ok: m.data === 'pong:ping', got: m.data });
      dc.onopen = () => dc.send('ping');
      setTimeout(() => resolve({ ok: false, got: null, timeout: true }), 25000);
    });
    await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
    const res = await result;
    let pair = null; const seenB = [];
    try {
      // что B РЕАЛЬНО видит с той стороны: remote-кандидаты B (prflx = пакеты пришли с адреса, не заявленного в SDP)
      const sb = await b.getStats();
      sb.forEach((s) => { if (s.type === 'remote-candidate') seenB.push(`${s.candidateType} ${s.address || s.ip}:${s.port}`); });
      const stats = await a.getStats();
      stats.forEach((s) => { if (s.type === 'candidate-pair' && (s.selected || s.state === 'succeeded') && !pair) {
        const l = stats.get(s.localCandidateId), rr = stats.get(s.remoteCandidateId);
        pair = { local: l && `${l.candidateType} ${l.address || l.ip}:${l.port} ${l.protocol}`, remote: rr && `${rr.candidateType} ${rr.address || rr.ip}:${rr.port}`, state: s.state };
      } });
    } catch (e) {}
    a.close(); b.close();
    return { ...res, pair, cands, seenB };
  }, { url2: url, user2: user, pass2: pass, asym: process.env.ASYM === '1' });
  console.log('candidates A:', r.cands.a.join(' | ') || '(none)');
  console.log('candidates B:', r.cands.b.map((c) => c.split(' ').slice(4, 8).join(' ')).join(' | ') || '(none)');
  console.log('pair:', JSON.stringify(r.pair));
  console.log('B видит удалённые кандидаты:', (r.seenB || []).join(' | ') || '(none)');
  console.log(r.ok ? 'LOOPBACK OK' : `LOOPBACK FAIL (${r.timeout ? 'timeout' : r.got})`);
  process.exit(r.ok ? 0 : 1);
} finally { await browser.close(); }
