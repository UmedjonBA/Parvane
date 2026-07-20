import { expect, test } from '@playwright/test';

const E2E_PASSWORD = 'Parvane-e2e-password';

test('cloud blobs require owner, recipient, or explicit public access', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Cloud authorization is browser-independent');

  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  expect(gatewayUrl, 'The live-stack runner must provide PARVANE_E2E_GATEWAY_URL').toBeTruthy();
  await page.goto('/redirect.js');

  const result = await page.evaluate(async ({ url, password }) => {
    type Frame = {
      op: string;
      id?: string;
      payload?: string;
      token?: string;
      subject?: string;
      timeout_ms?: number;
      error?: string;
    };
    type CloudResponse = {
      ok?: boolean;
      token?: string;
      data?: string;
      error?: string;
      files?: Array<{ file_id: string }>;
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
        return JSON.parse(frame.payload || '{}') as CloudResponse;
      };
      const requestMany = (subject: string, payload: object) => {
        const id = `${user}-${++requestId}`;
        return new Promise<CloudResponse[]>((resolve, reject) => {
          const replies: CloudResponse[] = [];
          const timer = window.setTimeout(() => {
            socket.removeEventListener('message', onMessage);
            reject(new Error(`Timed out reqmany ${subject} for ${user}`));
          }, 10000);
          const onMessage = (event: MessageEvent<string>) => {
            const frame = JSON.parse(event.data) as Frame;
            if (frame.id !== id) return;
            if (frame.op === 'reply') {
              replies.push(JSON.parse(frame.payload || '{}') as CloudResponse);
            } else if (frame.op === 'err') {
              window.clearTimeout(timer);
              socket.removeEventListener('message', onMessage);
              reject(new Error(frame.error || `Gateway rejected ${subject}`));
            } else if (frame.op === 'reply_end') {
              window.clearTimeout(timer);
              socket.removeEventListener('message', onMessage);
              resolve(replies);
            }
          };
          socket.addEventListener('message', onMessage);
          socket.send(JSON.stringify({
            op: 'reqmany', id, subject, payload: JSON.stringify(payload), timeout_ms: 200,
          }));
        });
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
      return { socket, request, requestMany, token: issue.token, user };
    };

    const [alice, bob, mallory] = await Promise.all([
      connect('cloud-alice@local'),
      connect('cloud-bob@local'),
      connect('cloud-mallory@local'),
    ]);
    const event = (client: typeof alice, payload: object) => ({
      id: crypto.randomUUID(), from: client.user, ts: Math.floor(Date.now() / 1000),
      token: client.token, payload,
    });
    const upload = async (fileId: string, publicAccess: boolean) => {
      const data = btoa(`private-${fileId}`);
      const chunk = await alice.request('file.upload.chunk', event(alice, {
        file_id: fileId, chunk_index: 0, total_chunks: 1, data,
        filename: 'private.bin', mime_type: 'application/octet-stream',
      }));
      const complete = await alice.request('file.upload.complete', event(alice, {
        file_id: fileId,
        filename: 'private.bin',
        total_chunks: 1,
        size_bytes: atob(data).length,
        mime_type: 'application/octet-stream',
        recipients: publicAccess ? [] : [bob.user],
        public_access: publicAccess,
      }));
      return { chunk, complete };
    };
    const download = (client: typeof alice, fileId: string) => client.requestMany(
      'file.download.request',
      event(client, { file_id: fileId }),
    );

    const privateFile = crypto.randomUUID();
    const privateUpload = await upload(privateFile, false);
    const [aliceDownload, bobDownload, malloryDownload, malloryList] = await Promise.all([
      download(alice, privateFile),
      download(bob, privateFile),
      download(mallory, privateFile),
      mallory.request('file.list.request', event(mallory, {})),
    ]);
    const overwrite = await mallory.request('file.upload.chunk', event(mallory, {
      file_id: privateFile, chunk_index: 0, total_chunks: 1,
      data: btoa('evil'), filename: 'evil.bin', mime_type: 'application/octet-stream',
    }));

    const publicFile = crypto.randomUUID();
    const publicUpload = await upload(publicFile, true);
    const publicDownload = await download(mallory, publicFile);

    alice.socket.close();
    bob.socket.close();
    mallory.socket.close();
    return {
      privateUploadOk: privateUpload.chunk.ok && privateUpload.complete.ok,
      ownerChunks: aliceDownload.filter(({ ok, data }) => ok && data).length,
      recipientChunks: bobDownload.filter(({ ok, data }) => ok && data).length,
      malloryChunks: malloryDownload.filter(({ ok, data }) => ok && data).length,
      malloryDenied: malloryDownload.some(({ ok, error }) => !ok && error?.includes('доступ запрещён')),
      malloryListHasFile: malloryList.files?.some(({ file_id: id }) => id === privateFile) || false,
      overwriteOk: overwrite.ok,
      publicUploadOk: publicUpload.chunk.ok && publicUpload.complete.ok,
      publicChunks: publicDownload.filter(({ ok, data }) => ok && data).length,
    };
  }, { url: gatewayUrl!, password: E2E_PASSWORD });

  expect(result).toEqual({
    privateUploadOk: true,
    ownerChunks: 1,
    recipientChunks: 1,
    malloryChunks: 0,
    malloryDenied: true,
    malloryListHasFile: false,
    overwriteOk: false,
    publicUploadOk: true,
    publicChunks: 1,
  });
});
