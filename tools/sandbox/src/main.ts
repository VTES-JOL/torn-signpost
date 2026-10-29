/**
 * Engine sandbox: `pnpm sandbox [--scenario file] [--catalog file] [--seed n]`.
 * Type console commands as any seat, judge or admin and see each viewer's table.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, styleText } from 'node:util';
import { type CardInfo, createCatalog } from '@torn-signpost/engine';
import { defaultSetup, Session } from './session.ts';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    catalog: { type: 'string' },
    seed: { type: 'string' },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const catalogFile = values.catalog ?? join(here, '../../../packages/engine/scenarios/catalog.json');
const raw = JSON.parse(readFileSync(catalogFile, 'utf8')) as CardInfo[] | { cards: CardInfo[] };
const catalog = createCatalog(Array.isArray(raw) ? raw : raw.cards);
const setup = values.scenario
  ? readFileSync(values.scenario, 'utf8').trimEnd()
  : defaultSetup(Number(values.seed ?? Math.floor(Math.random() * 1e9)));

const session = new Session(setup, catalog);
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  completer: (line: string) => session.complete(line),
});

const print = (lines: string[]) => {
  for (const line of lines) console.log(line);
};
console.log(
  styleText('bold', 'Torn Signpost engine sandbox') + styleText('dim', ' — .help for commands'),
);
print(session.view());

const prompt = () => {
  rl.setPrompt(`\n${styleText('cyan', session.who)}> `);
  rl.prompt();
};
prompt();
for await (const input of rl) {
  const [cmd, file] = input.trim().split(/\s+/);
  if (cmd === '.quit' || cmd === '.exit') break;
  if (cmd === '.save') {
    if (!file) console.log('Usage: .save <file>');
    else {
      writeFileSync(file, session.script);
      console.log(`Saved ${file}`);
    }
  } else {
    print(session.execute(input));
  }
  prompt();
}
rl.close();
