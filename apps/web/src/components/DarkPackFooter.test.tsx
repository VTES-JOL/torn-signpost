import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DARK_PACK_NOTICE, DarkPackFooter } from './DarkPackFooter.tsx';

describe('DarkPackFooter (LEGAL-01..03)', () => {
  it('carries the exact Dark Pack notice', () => {
    expect(DARK_PACK_NOTICE).toBe(
      'Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. For more information please visit worldofdarkness.com.',
    );
    expect(renderToStaticMarkup(<DarkPackFooter />)).toContain(DARK_PACK_NOTICE);
  });

  it('states the site is not official World of Darkness material', () => {
    expect(renderToStaticMarkup(<DarkPackFooter />)).toContain(
      'not official World of Darkness material',
    );
  });

  it('loads the logo from the content pack, never from the app bundle', () => {
    const html = renderToStaticMarkup(<DarkPackFooter contentUrl="https://content.example.org" />);
    expect(html).toContain('src="https://content.example.org/brand/dark-pack-logo.png"');
  });
});
