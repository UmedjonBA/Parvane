// Проверка TURN-релея глазами настоящего WebRTC-клиента (Chromium):
// собираем ICE-кандидаты с iceTransportPolicy=relay. Успех = есть relay-кандидат.
//   TURN_URL=turn:185.81.248.52:20478?transport=udp TURN_USER=... TURN_PASS=... \
//   node scripts/e2e_turn_relay_check.mjs
import { chromium } from 'playwright';

const url = process.env.TURN_URL;
const user = process.env.TURN_USER;
const pass = process.env.TURN_PASS;
if (!url || !user || !pass) {
  console.error('TURN_URL/TURN_USER/TURN_PASS required');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  const candidates = await page.evaluate(async ({ url2, user2, pass2 }) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: [url2], username: user2, credential: pass2 }],
      iceTransportPolicy: 'relay',
    });
    const found = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) found.push(e.candidate.candidate);
    };
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') resolve();
      };
      setTimeout(resolve, 15000);
    });
    pc.close();
    return found;
  }, { url2: url, user2: user, pass2: pass });
  console.log(candidates.join('\n') || '(no candidates)');
  const hasRelay = candidates.some((c) => c.includes(' typ relay '));
  console.log(hasRelay ? 'RELAY OK' : 'RELAY FAIL');
  process.exit(hasRelay ? 0 : 1);
} finally {
  await browser.close();
}
