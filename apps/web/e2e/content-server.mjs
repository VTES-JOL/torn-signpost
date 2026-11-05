/**
 * A stand-in for the content CDN in end-to-end tests: the engine's invented test cards, in the
 * content pack's format. Real card data is never committed (LEGAL-08). Every image is the same
 * blank square.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3102);
const catalog = JSON.parse(
  readFileSync(new URL('../../../packages/engine/scenarios/catalog.json', import.meta.url), 'utf8'),
);
const CLANS = { 't-vera': 'Toreador', 't-tomas': 'Brujah', 't-ilse': 'Tremere' };
const cards = catalog.cards.map((c) => ({
  id: c.id,
  name: c.name,
  printedName: c.name,
  kind: c.kind,
  types: c.types ?? [c.kind === 'crypt' ? 'Vampire' : 'Master'],
  ...(c.kind === 'crypt'
    ? { group: '2', capacity: c.capacity ?? 5, clans: [CLANS[c.id] ?? 'Caitiff'] }
    : {}),
  text: '',
  sets: ['Test Set'],
  legalFrom: '2000-01-01',
  v5: true,
  aliases: [],
  artists: [],
}));
const manifest = {
  schema: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: { name: 'test cards', url: 'http://localhost' },
  cards: 'data/cards.test.json',
  count: cards.length,
  images: {
    pattern: 'cards/{id}/{size}.webp',
    sizes: { thumb: 160, full: 480 },
    backs: { crypt: 'backs/crypt-{size}.webp', library: 'backs/library-{size}.webp' },
  },
  formats: { v5Sets: ['Test Set'] },
};
// A 1×1 transparent PNG; browsers sniff the type, so it stands in for the .webp scans.
const BLANK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const files = {
  '/data/manifest.json': manifest,
  '/data/cards.test.json': cards,
};

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path.startsWith('/cards/') || path.startsWith('/backs/')) {
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(BLANK);
    return;
  }
  const body = files[path];
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}).listen(port, () => console.log(`test content on http://localhost:${port}`));
