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

/** The first comment line: what the scenario shows. */
function leadingComment(source: string): string {
  const first = source.split('\n').find((l) => l.trim().startsWith('#'));
  return first ? first.replace(/^\s*#\s*/, '') : '';
}

/** "01-first-turn" → "First turn". */
export function scenarioTitle(name: string): string {
  const words = name.replace(/^\d+-/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
