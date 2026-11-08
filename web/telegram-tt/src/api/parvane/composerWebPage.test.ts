import { describe, expect, it } from 'vitest';

import { buildComposerWebPage, composerWebPageId } from './composerWebPage';

describe('composer link preview (A2)', () => {
  it('builds a full web page card the composer can show, keyed by the url', () => {
    const page = buildComposerWebPage('https://example.org/post/1', {
      siteName: 'Example', title: 'A post', description: 'About things',
      image: { blobUrl: 'blob:local/1', width: 800, height: 400 },
    });
    expect(page.webpageType).toBe('full');
    expect(page.id).toBe(composerWebPageId('https://example.org/post/1'));
    expect(page.url).toBe('https://example.org/post/1');
    expect(page.displayUrl).toBe('example.org');
    expect(page.title).toBe('A post');
    expect(page.photo?.blobUrl).toBe('blob:local/1');
    expect(page.photo?.sizes[0]).toEqual({ type: 'x', width: 800, height: 400 });
  });

  it('without metadata falls back to the host name, like the sent message', () => {
    const page = buildComposerWebPage('https://example.org/x');
    expect(page.siteName).toBe('example.org');
    expect(page.photo).toBeUndefined();
    expect(composerWebPageId('https://a.example')).not.toBe(composerWebPageId('https://b.example'));
  });
});
