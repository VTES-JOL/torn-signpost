/**
 * The real-card scenarios, bundled into the web app for the replay player. They name cards by
 * VEKN ID only; names and images come from the content pack at runtime (LEGAL-08).
 */
const files = import.meta.glob<string>(
  '../../../../packages/engine/scenarios/real-cards/*.scenario',
  { query: '?raw', import: 'default', eager: true },
);

export interface ScenarioFile {
  /** File name without the extension, used in the URL. */
  name: string;
  /** The script's leading comment, as a description. */
  summary: string;
  source: string;
}

export const SCENARIOS: ScenarioFile[] = Object.entries(files)
  .map(([path, source]) => ({
    name: path.replace(/^.*\//, '').replace(/\.scenario$/, ''),
    summary: leadingComment(source),
    source,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The first sentence of the leading comment, which may run over several lines. */
export function leadingComment(source: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('#'));
  if (start < 0) return '';
  const block: string[] = [];
  for (const l of lines.slice(start)) {
    if (!l.trim().startsWith('#')) break;
    block.push(l.replace(/^\s*#\s*/, ''));
  }
  const text = block.join(' ');
  return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
}

/** "01-first-turn" → "First turn". */
export function scenarioTitle(name: string): string {
  const words = name.replace(/^\d+-/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
