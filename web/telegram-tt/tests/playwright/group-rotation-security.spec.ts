import { expect, test } from '@playwright/test';

const E2E_PASSWORD = 'Parvane-e2e-password';

test('banned group member loses metadata and future ciphertext delivery', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Gateway authorization is browser-independent');

  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  expect(gatewayUrl, 'The live-stack runner must provide PARVANE_E2E_GATEWAY_URL').toBeTruthy();
  await page.goto('/redirect.js');

  const result = await page.evaluate(async ({ url, password }) => {
    type Frame = {
      op: string;
      id?: string;
      subject?: string;
      payload?: string;
      token?: string;
      timeout_ms?: number;
      error?: string;
    };
    type Response = {
      ok?: boolean;
      token?: string;
      group_id?: string;
      groups?: Array<{
        group_id: string;
        members: Array<{ address: string; role: string }>;
      }>;
      error?: string;
    };

    const connect = async (user: string) => {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error(`WebSocket failed for ${user}`)), { once: true });
      });
      let requestId = 0;
      const waitFor = (accept: (frame: Frame) => boolean, timeoutMs = 10000) => (
        new Promise<Frame>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            socket.removeEventListener('message', onMessage);
            reject(new Error(`Timed out waiting for ${user}`));
          }, timeoutMs);
          const onMessage = (event: MessageEvent<string>) => {
            const frame = JSON.parse(event.data) as Frame;
            if (!accept(frame)) return;
            window.clearTimeout(timer);
            socket.removeEventListener('message', onMessage);
            resolve(frame);
          };
          socket.addEventListener('message', onMessage);
        })
      );
      const exchange = (frame: Frame, accept: (response: Frame) => boolean) => {
        const response = waitFor(accept);
        socket.send(JSON.stringify(frame));
        return response;
      };
      const request = async (subject: string, payload: object) => {
        const id = `${user}-${++requestId}`;
        const frame = await exchange({
          op: 'req', id, subject, payload: JSON.stringify(payload), timeout_ms: 10000,
        }, (response) => response.id === id && (response.op === 'reply' || response.op === 'err'));
        if (frame.op === 'err') throw new Error(frame.error || `Gateway rejected ${subject}`);
        return JSON.parse(frame.payload || '{}') as Response;
      };

      let issue = await request('identity.token.issue', { user, password });
      if (!issue.ok) {
        const registration = await request('identity.user.register', { user, password, invite: '' });
        if (!registration.ok) throw new Error(registration.error || `Registration failed for ${user}`);
        issue = await request('identity.token.issue', { user, password });
      }
      if (!issue.ok || !issue.token) throw new Error(issue.error || `Token issue failed for ${user}`);
      const auth = await exchange({ op: 'auth', token: issue.token }, (frame) => (
        frame.op === 'auth_ok' || frame.op === 'auth_err'
      ));
      if (auth.op !== 'auth_ok') throw new Error(auth.error || `Authentication failed for ${user}`);
      return { socket, request, waitFor, token: issue.token };
    };

    const ownerAddress = 'rotation-owner@local';
    const memberAddress = 'rotation-member@local';
    const malloryAddress = 'rotation-mallory@local';
    const [owner, member, mallory] = await Promise.all([
      connect(ownerAddress), connect(memberAddress), connect(malloryAddress),
    ]);

    const created = await owner.request('group.create', {
      token: owner.token,
      name: 'Rotation security',
      kind: 'group',
      members: [memberAddress, malloryAddress],
    });
    if (!created.ok || !created.group_id) throw new Error(created.error || 'Group creation failed');
    const groupId = created.group_id;

    member.socket.send(JSON.stringify({ op: 'sub', subject: `msg.user.${memberAddress}` }));
    let malloryDeliveries = 0;
    mallory.socket.addEventListener('message', (event: MessageEvent<string>) => {
      const frame = JSON.parse(event.data) as Frame;
      if (frame.op === 'msg' && frame.subject === `msg.user.${malloryAddress}`) malloryDeliveries++;
    });
    mallory.socket.send(JSON.stringify({ op: 'sub', subject: `msg.user.${malloryAddress}` }));
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    const ban = await owner.request('group.ban', {
      token: owner.token, group_id: groupId, member: malloryAddress,
    });
    const [ownerInfo, malloryInfo, malloryList] = await Promise.all([
      owner.request('group.info', { token: owner.token, group_id: groupId }),
      mallory.request('group.info', { token: mallory.token, group_id: groupId }),
      mallory.request('group.list', { token: mallory.token }),
    ]);

    const memberInbox = member.waitFor((frame) => (
      frame.op === 'msg' && frame.subject === `msg.user.${memberAddress}`
    ));
    owner.socket.send(JSON.stringify({
      op: 'pub',
      subject: 'msg.chat.send',
      payload: JSON.stringify({
        id: crypto.randomUUID(),
        from: ownerAddress,
        ts: Math.floor(Date.now() / 1000),
        token: owner.token,
        payload: {
          to: groupId,
          content: {
            kind: 'group_encrypted',
            ciphertext: 'new-epoch-ciphertext',
            group: groupId,
            sender_identity: 'rotation-owner-identity',
          },
        },
      }),
    }));
    const delivered = await memberInbox;
    await new Promise((resolve) => window.setTimeout(resolve, 300));

    owner.socket.close();
    member.socket.close();
    mallory.socket.close();
    return {
      banOk: ban.ok,
      memberReceived: delivered.op === 'msg',
      malloryDeliveries,
      malloryInfoCount: malloryInfo.groups?.length || 0,
      malloryListHasGroup: malloryList.groups?.some((group) => group.group_id === groupId) || false,
      malloryRole: ownerInfo.groups?.[0]?.members
        .find(({ address }) => address === malloryAddress)?.role,
    };
  }, { url: gatewayUrl!, password: E2E_PASSWORD });

  expect(result).toEqual({
    banOk: true,
    memberReceived: true,
    malloryDeliveries: 0,
    malloryInfoCount: 0,
    malloryListHasGroup: false,
    malloryRole: 'banned',
  });
});
