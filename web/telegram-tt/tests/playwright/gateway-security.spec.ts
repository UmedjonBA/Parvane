import { expect, test } from '@playwright/test';

const E2E_PASSWORD = 'Parvane-e2e-password';

type ServiceResponse = {
  ok: boolean;
  token?: string;
  user?: string;
  error?: string;
};

test('Mallory cannot subscribe to gateway-owned NATS reply inboxes', async ({ page }, testInfo) => {
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

    const subscribe = async (subject: string) => {
      const frame = await exchange({ op: 'sub', subject }, (response) => response.op === 'err');
      return frame.error || '';
    };
    const wildcardError = await subscribe('_INBOX.>');
    const concreteError = await subscribe('_INBOX.mallory-secret');
    const verify = await request('identity.token.verify', { token: issue.token });
    socket.close();

    return { wildcardError, concreteError, verify };
  }, {
    url: gatewayUrl,
    user: 'mallory-inbox@local',
    password: E2E_PASSWORD,
  });

  expect(result.wildcardError).toContain('запрещ');
  expect(result.concreteError).toContain('запрещ');
  expect(result.verify).toMatchObject({ ok: true, user: 'mallory-inbox@local' });
});
