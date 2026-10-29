import { useState } from 'react';

/** Exact notice required by the Dark Pack Agreement (LEGAL-02). Do not edit. */
export const DARK_PACK_NOTICE =
  'Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. For more information please visit worldofdarkness.com.';

const SOURCE_URL = 'https://github.com/VTES-JOL/torn-signpost';

interface Props {
  /** Content pack origin; the logo is WoD material and is never bundled with the app (LEGAL-08). */
  contentUrl?: string | undefined;
}

/** Persistent footer with the Dark Pack logo and notices (LEGAL-01..03). */
export function DarkPackFooter({ contentUrl }: Props) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = contentUrl !== undefined && !logoFailed;

  return (
    <footer className="site-footer">
      <a
        className="dark-pack-badge"
        href="https://www.paradoxinteractive.com/games/world-of-darkness/community/dark-pack-agreement"
        rel="noopener noreferrer"
        target="_blank"
      >
        {showLogo ? (
          <img
            src={`${contentUrl}/brand/dark-pack-logo.png`}
            alt="Dark Pack"
            width={64}
            height={64}
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="dark-pack-fallback">Dark Pack</span>
        )}
      </a>
      <div className="notices">
        <p>{DARK_PACK_NOTICE}</p>
        <p>
          Torn Signpost is not official World of Darkness material. It is a free, non-commercial fan
          project, not affiliated with or endorsed by Paradox Interactive, Black Chantry Productions
          or the VEKN.
        </p>
        <p>
          Code licensed under{' '}
          <a href={`${SOURCE_URL}/blob/main/LICENSE`} rel="noopener noreferrer" target="_blank">
            AGPL-3.0
          </a>{' '}
          ·{' '}
          <a href={SOURCE_URL} rel="noopener noreferrer" target="_blank">
            Source
          </a>
        </p>
      </div>
    </footer>
  );
}
