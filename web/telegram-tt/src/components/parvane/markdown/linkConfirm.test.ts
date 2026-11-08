import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { handleMarkdownLinkClick } from './linkConfirm';
import { linkNeedsConfirmation } from './markdown';

// C7-4 (ревью 7 ноя 2026): ссылка заметки и статьи с подписью, не совпадающей с адресом, открывается только через
// окно с настоящим адресом (`openUrl` → `SafeLinkModal`), как в desktop/android (`linkNeedsConfirmation` ядра).
// Адреса — выдуманные

function click(text: string, url: string, init: { type?: string; button?: number } = { type: 'click' }) {
  const preventDefault = vi.fn();
  const openUrl = vi.fn();
  handleMarkdownLinkClick({ preventDefault, ...init }, text, url, openUrl);
  return { preventDefault, openUrl };
}

describe('C7-4: подтверждение перехода по ссылке заметки и статьи', () => {
  it('подпись-адрес другого сайта — окно подтверждения, браузер сам не переходит', () => {
    const { preventDefault, openUrl } = click('https://parvane.example/login', 'https://evil.example');
    expect(preventDefault).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith({ url: 'https://evil.example', shouldSkipModal: false });
  });

  it('словесная подпись — тоже с окном; голый адрес — без окна, но через openUrl', () => {
    expect(click('документация', 'https://docs.example').openUrl)
      .toHaveBeenCalledWith({ url: 'https://docs.example', shouldSkipModal: false });
    const bare = click('https://docs.example/a', 'https://docs.example/a');
    expect(bare.preventDefault).toHaveBeenCalled();
    expect(bare.openUrl).toHaveBeenCalledWith({ url: 'https://docs.example/a', shouldSkipModal: true });
  });

  it('домен со смешанными письменностями — с окном даже при совпадающей подписи', () => {
    const url = 'https://pаrvane.example'; // «а» кириллицей
    expect(click(url, url).openUrl).toHaveBeenCalledWith({ url, shouldSkipModal: false });
  });

  it('средняя кнопка не обходит окно; правая кнопка не трогается', () => {
    const middle = click('x', 'https://evil.example', { type: 'auxclick', button: 1 });
    expect(middle.openUrl).toHaveBeenCalledWith({ url: 'https://evil.example', shouldSkipModal: false });
    const right = click('x', 'https://evil.example', { type: 'auxclick', button: 2 });
    expect(right.preventDefault).not.toHaveBeenCalled();
    expect(right.openUrl).not.toHaveBeenCalled();
  });

  it('сравнение подписи с адресом — как в ядре', () => {
    expect(linkNeedsConfirmation('www.docs.example', 'https://www.docs.example/')).toBe(false);
    expect(linkNeedsConfirmation('Docs.Example', 'http://docs.example')).toBe(false);
    expect(linkNeedsConfirmation('user@mail.example', 'mailto:user@mail.example')).toBe(false);
    expect(linkNeedsConfirmation('  ', 'https://docs.example')).toBe(false);
    expect(linkNeedsConfirmation('docs.example', 'https://docs.example.evil')).toBe(true);
  });

  it('ссылки заметки, статьи и встроенного внешнего файла идут через MarkdownLink', () => {
    const read = (path: string) => readFileSync(join(__dirname, path), 'utf8');
    ['MarkdownBlocks.tsx', '../article/ArticleBody.tsx', '../notes/NoteEmbed.tsx'].forEach((path) => {
      const source = read(path);
      expect(source).toContain('<MarkdownLink');
      expect(source).not.toMatch(/target="_blank"/);
    });
    expect(read('MarkdownLink.tsx')).toContain('handleMarkdownLinkClick');
  });
});
