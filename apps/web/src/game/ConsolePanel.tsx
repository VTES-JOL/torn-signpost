/** Command console (GAME-13, UX-12): toggled with ` or the Console button; same commands as the UI. */

import type { CardCatalog } from '@torn-signpost/engine';
import { type ConsoleContext, completeConsole, parseConsole } from '@torn-signpost/engine/console';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { useState } from 'react';
import { ApiError } from '../api.ts';
import type { GameClient, GameSnapshot } from './client.ts';

export function ConsolePanel(props: {
  client: GameClient;
  snapshot: GameSnapshot;
  catalog: CardCatalog;
}) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [output, setOutput] = useState<{ text: string; error?: boolean }[]>([]);
  const ctx: ConsoleContext = { view: props.snapshot.view, catalog: props.catalog };
  if (props.snapshot.seat) ctx.seat = props.snapshot.seat;
  const suggestions = input ? completeConsole(input, ctx).slice(0, 8) : [];
  const say = (text: string, error = false) =>
    setOutput((o) => [...o.slice(-50), error ? { text, error } : { text }]);

  const run = async () => {
    const line = input.trim();
    if (!line) return;
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 50));
    setCursor(-1);
    setInput('');
    say(`> ${line}`);
    const parsed = parseConsole(line, ctx);
    if (!parsed.ok) return say(parsed.error, true);
    if (parsed.command.type === 'StartGame') return say('Not available', true);
    try {
      await props.client.send(parsed.command as PlayerCommand);
      say('ok');
    } catch (e) {
      say(e instanceof ApiError ? e.message : String(e), true);
    }
  };

  const complete = () => {
    const [first] = suggestions;
    if (!first) return;
    setInput(input.replace(/("[^"]*|\S*)$/, `${first} `));
  };

  return (
    <div className="console">
      <ol className="console-output" aria-live="polite">
        {output.map((o, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only output
          <li key={i} className={o.error ? 'error' : undefined}>
            {o.text}
          </li>
        ))}
      </ol>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          aria-label="Console command"
          placeholder="e.g. blood +2 ready:1, draw 2, move hand:1 ready"
          value={input}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && suggestions.length) {
              e.preventDefault();
              complete();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              const next = Math.min(cursor + 1, history.length - 1);
              setCursor(next);
              setInput(history[next] ?? input);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const next = Math.max(cursor - 1, -1);
              setCursor(next);
              setInput(next < 0 ? '' : (history[next] ?? ''));
            }
          }}
        />
      </form>
      {suggestions.length > 0 && <p className="muted small">Tab: {suggestions.join(' · ')}</p>}
    </div>
  );
}
