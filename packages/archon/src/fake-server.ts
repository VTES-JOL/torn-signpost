/**
 * The fake Archon over HTTP, for the end-to-end tests (and trying the flows locally):
 * `PORT=3103 pnpm --filter @torn-signpost/archon fake`. Besides Archon's routes, tests control it
 * through `/_fake/…`: add a member, sign one in (who then approves every consent), add a
 * tournament, read the actions it received.
 */
import http from 'node:http';
import { FakeArchon } from './fake.ts';

const port = Number(process.env.PORT ?? 3103);
const fake = new FakeArchon(
  {
    id: process.env.ARCHON_CLIENT_ID ?? 'fake-client',
    secret: process.env.ARCHON_CLIENT_SECRET ?? 'fake-secret',
    redirectUris: (
      process.env.ARCHON_REDIRECT_URIS ??
      'http://localhost:5174/archon/callback,http://localhost:5173/archon/callback'
    ).split(','),
  },
  `http://localhost:${port}`,
);

async function control(req: http.IncomingMessage, path: string): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (path === '/_fake/members') return fake.addMember(body);
  if (path === '/_fake/sign-in') {
    fake.signedIn = body.uid ?? undefined;
    return { signedIn: fake.signedIn ?? null };
  }
  if (path === '/_fake/tournaments')
    return fake.addTournament(body.organizer, body.tournament ?? {});
  if (path === '/_fake/log') return fake.log;
  return undefined;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    try {
      if (url.pathname.startsWith('/_fake/')) {
        const out = await control(req, url.pathname);
        res.writeHead(out === undefined ? 404 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out ?? { detail: 'Not Found' }));
        return;
      }
      if (url.pathname === '/health') {
        res.writeHead(200).end('ok');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const answer = await fake.handle(
        new Request(url, {
          method: req.method ?? 'GET',
          headers: Object.entries(req.headers).flatMap(([k, v]) =>
            typeof v === 'string' ? [[k, v]] : [],
          ),
          ...(body ? { body } : {}),
        }),
      );
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch (e) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ detail: String(e) }));
    }
  })
  .listen(port, () => console.log(`fake Archon on http://localhost:${port}`));
