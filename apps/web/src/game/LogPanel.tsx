/** Game log with chat interleaved (GAME-12); spectators read but cannot chat (GAME-16). */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import type { GameClient, GameSnapshot } from './client.ts';

type Entry = {
  key: string;
  seq: number;
  order: number;
  text: string;
  who?: string;
  mention?: boolean;
};

export function LogPanel(props: {
  client: GameClient;
  snapshot: GameSnapshot;
  canChat: boolean;
  me?: string | undefined;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const end = useRef<HTMLLIElement>(null);
  const entries: Entry[] = [
    ...props.snapshot.log.map((l) => ({ key: `e${l.seq}`, seq: l.seq, order: 0, text: l.text })),
    ...props.snapshot.chat.map((m, i) => ({
      key: m.id,
      seq: m.seq,
      order: 1 + i,
      text: m.text,
      who: m.name,
      mention: !!props.me && m.text.toLowerCase().includes(`@${props.me.toLowerCase()}`),
    })),
  ].sort((a, b) => a.seq - b.seq || a.order - b.order);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new entries arrive
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [entries.length]);
  return (
    <div className="log">
      <ol className="log-entries" aria-label="Game log and chat">
        {entries.map((e) => (
          <li key={e.key} className={[e.who ? 'chat' : '', e.mention ? 'mention' : ''].join(' ')}>
            {e.who && <strong>{e.who}: </strong>}
            {e.text}
          </li>
        ))}
        <li ref={end} aria-hidden />
      </ol>
      {props.canChat ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            setText('');
            props.client
              .say(t)
              .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
          }}
        >
          <input
            aria-label="Chat message"
            placeholder="Say something… (@name to mention)"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
          />
        </form>
      ) : (
        <p className="muted small">Spectators can read the chat but not take part.</p>
      )}
      {error && <p className="notice small">{error}</p>}
    </div>
  );
}
