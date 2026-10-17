import { describe, expect, it } from 'vitest';

import type { ExportSourceChat } from './exportModel';

import {
  assignChatDirs, buildChatMessages, DEFAULT_EXPORT_LABELS, escapeHtml, exportArchiveName, hrefOf, renderChatHtml,
  renderChatJson, renderIndexHtml, sanitizeFileName, uniqueName,
} from './exportModel';

const chat: ExportSourceChat = {
  address: 'kestrel@example.test',
  kind: 'user',
  title: 'Kestrel <Fox>',
  messages: [
    {
      uuid: 'u1', from: 'kestrel@example.test', fromName: 'Kestrel', isOutgoing: false, ts: 1_700_000_000,
      content: { kind: 'text', text: 'hi <b>there</b> & "you"' },
    },
    {
      uuid: 'u2', from: 'owl@example.test', fromName: 'Owl', isOutgoing: true, ts: 1_700_000_060, replyTo: 'u1',
      edited: true, editedAt: 1_700_000_100,
      content: {
        kind: 'photo', file_id: 'f-photo', mime: 'image/jpeg', caption: 'a pond', width: 640, height: 480,
      },
      reactions: [{ emoji: '👍', count: 2 }],
    },
    {
      uuid: 'u3', from: 'owl@example.test', fromName: 'Owl', isOutgoing: true, ts: 1_700_000_070,
      content: { kind: 'poll_vote', poll: 'p1', options: [0] },
    },
    {
      uuid: 'u4', from: 'kestrel@example.test', fromName: 'Kestrel', isOutgoing: false, ts: 1_700_000_080,
      content: {
        kind: 'file', file_id: 'f-doc', mime: 'application/pdf', filename: '../../secret/plan?.pdf',
      },
    },
    {
      uuid: 'u5', from: 'kestrel@example.test', fromName: 'Kestrel', isOutgoing: false, ts: 1_700_000_090,
      content: { kind: 'poll', question: 'Tea or coffee?', options: ['Tea', 'Coffee'] },
    },
    {
      uuid: 'u6', from: 'kestrel@example.test', fromName: 'Kestrel', isOutgoing: false, ts: 1_700_000_095,
      content: { kind: 'chat_mode', l2: true },
    },
  ],
};

describe('export file names', () => {
  it('cleans unsafe names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_etc_passwd');
    expect(sanitizeFileName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName('CON.txt', 'x')).toBe('x');
    expect(sanitizeFileName('Привет мир')).toBe('Привет мир');
    const long = sanitizeFileName(`${'a'.repeat(200)}.jpeg`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('.jpeg')).toBe(true);
  });

  it('makes names unique case-insensitively', () => {
    const taken = new Set<string>();
    expect(uniqueName(taken, 'a.jpg')).toBe('a.jpg');
    expect(uniqueName(taken, 'A.jpg')).toBe('A (2).jpg');
    expect(uniqueName(taken, 'a.jpg')).toBe('a (3).jpg');
  });

  it('names the archive after the nick and the day', () => {
    expect(exportArchiveName('owl@example.test', new Date(2026, 0, 5, 12))).toBe('parvane-export-owl-2026-01-05.zip');
  });

  it('encodes link paths per segment', () => {
    expect(hrefOf('chats/001-Чат #1/messages.html')).toBe('chats/001-%D0%A7%D0%B0%D1%82%20%231/messages.html');
  });
});

describe('export messages', () => {
  it('numbers messages, maps replies and media paths, drops protocol rows', () => {
    const messages = buildChatMessages(chat, true);
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'u2', 'u4', 'u5', 'u6']);
    expect(messages[1].replyToId).toBe(1);
    expect(messages[1].media).toMatchObject({ path: 'media/00002-photo-2.jpg', status: 'included' });
    expect(messages[1].text).toBe('a pond');
    expect(messages[2].media?.path).toBe('media/00003-_secret_plan_.pdf');
    expect(messages[3].poll).toEqual({ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] });
    expect(messages[4]).toMatchObject({ type: 'service', action: 'privacy_on' });
  });

  it('marks media as not included when media are off', () => {
    const messages = buildChatMessages(chat, false);
    expect(messages[1].media?.status).toBe('not_included');
  });

  it('renders JSON with dates, replies and media files', () => {
    const [exported] = assignChatDirs([chat], DEFAULT_EXPORT_LABELS, true);
    expect(exported.dir).toBe('chats/001-Kestrel _Fox_');
    const json = JSON.parse(renderChatJson(exported));
    expect(json.name).toBe('Kestrel <Fox>');
    expect(json.messages[0]).toMatchObject({
      id: 1,
      date: '2023-11-14T22:13:20.000Z',
      date_unixtime: '1700000000',
      from: 'Kestrel',
      text: 'hi <b>there</b> & "you"',
    });
    expect(json.messages[1]).toMatchObject({
      reply_to_message_id: 1,
      outgoing: true,
      media: { kind: 'photo', file: 'media/00002-photo-2.jpg', status: 'included', mime_type: 'image/jpeg' },
      reactions: [{ emoji: '👍', count: 2 }],
    });
    expect(json.messages[1].edited).toBe('2023-11-14T22:15:00.000Z');
  });

  it('escapes HTML in chat pages and index', () => {
    const [exported] = assignChatDirs([chat], DEFAULT_EXPORT_LABELS, true);
    const html = renderChatHtml(exported, DEFAULT_EXPORT_LABELS);
    expect(html).toContain('hi &lt;b&gt;there&lt;/b&gt; &amp; &quot;you&quot;');
    expect(html).not.toContain('<b>there</b>');
    expect(html).toContain('<title>Kestrel &lt;Fox&gt;</title>');
    expect(html).toContain('href="#message-1"');
    expect(html).toContain('<img src="media/00002-photo-2.jpg"');
    const index = renderIndexHtml(
      { address: 'owl@example.test', name: 'Owl <3' }, [exported], { contacts: 'contacts.json' },
      DEFAULT_EXPORT_LABELS, new Date(2026, 0, 5),
    );
    expect(index).toContain('Owl &lt;3');
    expect(index).toContain('href="chats/001-Kestrel%20_Fox_/messages.html"');
    expect(index).toContain('Kestrel &lt;Fox&gt;');
  });

  it('shows a placeholder for media that failed', () => {
    const [exported] = assignChatDirs([chat], DEFAULT_EXPORT_LABELS, true);
    exported.messages[1].media!.status = 'unavailable';
    const html = renderChatHtml(exported, DEFAULT_EXPORT_LABELS);
    expect(html).toContain(DEFAULT_EXPORT_LABELS.mediaUnavailable);
    expect(JSON.parse(renderChatJson(exported)).messages[1].media.file).toBeUndefined();
  });

  it('escapes all special characters', () => {
    expect(escapeHtml(`<a href='x'>&"</a>`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;&quot;&lt;/a&gt;');
  });

  it('titles Saved Messages with the label', () => {
    const [saved] = assignChatDirs([{ ...chat, kind: 'saved', title: 'owl' }], DEFAULT_EXPORT_LABELS, false);
    expect(saved.title).toBe('Saved Messages');
    expect(saved.dir).toBe('chats/001-Saved Messages');
  });
});
