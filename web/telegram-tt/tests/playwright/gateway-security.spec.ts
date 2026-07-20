import { expect, test } from '@playwright/test';

const E2E_PASSWORD = 'Parvane-e2e-password';

type ServiceResponse = {
  ok: boolean;
  token?: string;
  user?: string;
  error?: string;
};

test('gateway binds Mallory to her session and denies private NATS subjects', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Gateway authorization is browser-independent');

  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  expect(gatewayUrl, 'The live-stack runner must provide PARVANE_E2E_GATEWAY_URL').toBeTruthy();

  await page.goto('/redirect.js');
  const result = await page.evaluate(async ({ url, user, password }) => {
    type Frame = {
      op: string;
      id?: string;
      subject?: string;
      payload?: string;
      token?: string;
      timeout_ms?: number;
      user?: string;
      error?: string;
    };

    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Gateway WebSocket failed')), { once: true });
    });

    const waitForFrame = (accept: (frame: Frame) => boolean) => {
      return new Promise<Frame>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          socket.removeEventListener('message', handleMessage);
          reject(new Error('Timed out waiting for gateway frame'));
        }, 10000);
        const handleMessage = (event: MessageEvent<string>) => {
          const frame = JSON.parse(event.data) as Frame;
          if (!accept(frame)) return;
          window.clearTimeout(timer);
          socket.removeEventListener('message', handleMessage);
          resolve(frame);
        };
        socket.addEventListener('message', handleMessage);
      });
    };

    const exchange = (frame: Frame, accept: (response: Frame) => boolean) => {
      const response = waitForFrame(accept);
      socket.send(JSON.stringify(frame));
      return response;
    };

    let requestId = 0;
    const request = async (subject: string, payload: object) => {
      const id = String(++requestId);
      const frame = await exchange({
        op: 'req', id, subject, payload: JSON.stringify(payload), timeout_ms: 10000,
      }, (response) => response.id === id && (response.op === 'reply' || response.op === 'err'));
      if (frame.op === 'err') throw new Error(frame.error || `Gateway rejected ${subject}`);
      return JSON.parse(frame.payload || '{}') as ServiceResponse;
    };

    let issue = await request('identity.token.issue', { user, password });
    if (!issue.ok) {
      const registration = await request('identity.user.register', { user, password, invite: '' });
      if (!registration.ok) throw new Error(registration.error || 'Mallory registration failed');
      issue = await request('identity.token.issue', { user, password });
    }
    if (!issue.ok || !issue.token) throw new Error(issue.error || 'Mallory token issue failed');

    const auth = await exchange({ op: 'auth', token: issue.token }, (frame) => (
      frame.op === 'auth_ok' || frame.op === 'auth_err'
    ));
    if (auth.op !== 'auth_ok') throw new Error(auth.error || 'Mallory auth failed');

    const webUserId = (address: string) => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < address.length; i++) {
        hash ^= address.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return String(hash >>> 1);
    };

    const ownId = webUserId(user);
    socket.send(JSON.stringify({ op: 'sub', subject: 'presence.*' }));
    socket.send(JSON.stringify({ op: 'sub', subject: `msg.typing.${ownId}` }));
    socket.send(JSON.stringify({ op: 'sub', subject: `msg.user.${user}` }));
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const receivePublished = async (subject: string, payload: object) => {
      const incoming = waitForFrame((frame) => frame.op === 'msg' && frame.subject === subject);
      socket.send(JSON.stringify({ op: 'pub', subject, payload: JSON.stringify(payload) }));
      return incoming;
    };

    const presence = await receivePublished(`presence.${ownId}`, { from: 'victim@local' });
    const typing = await receivePublished(`msg.typing.${ownId}`, {
      from: 'victim@local', to: user,
    });

    const inbox = waitForFrame((frame) => frame.op === 'msg' && frame.subject === `msg.user.${user}`);
    socket.send(JSON.stringify({
      op: 'pub',
      subject: 'msg.chat.send',
      payload: JSON.stringify({
        id: crypto.randomUUID(),
        from: 'victim@local',
        ts: Math.floor(Date.now() / 1000),
        token: 'forged-victim-token',
        payload: { to: user, content: { kind: 'text', text: 'spoof-attempt' } },
      }),
    }));
    const inboxFrame = await inbox;

    const publishRejected = async (subject: string) => {
      const frame = await exchange(
        { op: 'pub', subject, payload: JSON.stringify({ from: 'victim@local' }) },
        (response) => response.op === 'err',
      );
      return frame.error || '';
    };
    const foreignPresenceError = await publishRejected(`presence.${webUserId('victim@local')}`);
    const typingWildcardError = await publishRejected('msg.typing.>');

    const subscribe = async (subject: string) => {
      const frame = await exchange({ op: 'sub', subject }, (response) => response.op === 'err');
      return frame.error || '';
    };
    const wildcardError = await subscribe('_INBOX.>');
    const concreteError = await subscribe('_INBOX.mallory-secret');
    const verify = await request('identity.token.verify', { token: issue.token });
    socket.close();

    const presencePayload = JSON.parse(presence.payload || '{}') as { from?: string };
    const typingPayload = JSON.parse(typing.payload || '{}') as { from?: string };
    const inboxPayload = JSON.parse(inboxFrame.payload || '{}') as {
      payload?: { message?: { from?: string } };
    };

    return {
      wildcardError,
      concreteError,
      verify,
      presenceFrom: presencePayload.from,
      typingFrom: typingPayload.from,
      messageFrom: inboxPayload.payload?.message?.from,
      foreignPresenceError,
      typingWildcardError,
    };
  }, {
    url: gatewayUrl,
    user: 'mallory-inbox@local',
    password: E2E_PASSWORD,
  });

  expect(result.wildcardError).toContain('запрещ');
  expect(result.concreteError).toContain('запрещ');
  expect(result.verify).toMatchObject({ ok: true, user: 'mallory-inbox@local' });
  expect(result.presenceFrom).toBe('mallory-inbox@local');
  expect(result.typingFrom).toBe('mallory-inbox@local');
  expect(result.messageFrom).toBe('mallory-inbox@local');
  expect(result.foreignPresenceError).toContain('запрещ');
  expect(result.typingWildcardError).toContain('запрещ');
});
