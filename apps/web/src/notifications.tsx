/**
 * In-app notifications (NOTIF-01): the list and unread count from the API, new ones pushed over a
 * WebSocket of their own (so they arrive on every page), the bell in the header and the count in
 * the tab title.
 */
import type {
  MarkReadRequest,
  Notification,
  NotificationsResponse,
  ServerMessage,
} from '@torn-signpost/protocol';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { useApi } from './api.ts';
import { useAuth } from './auth.tsx';
import { useConfig } from './content.tsx';
import { formatLeft } from './game/Clock.tsx';
import { setUnreadTitle } from './title.ts';

/** API Gateway drops idle sockets after 10 minutes. */
const KEEPALIVE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30_000;
/** Tell the server the user is here at most this often, so email waits (NOTIF-02). */
const ACTIVE_EVERY_MS = 2 * 60_000;

interface Notifications {
  items: Notification[];
  unread: number;
  more: boolean;
  loadMore(): void;
  markRead(req: MarkReadRequest): void;
}

const NotificationsContext = createContext<Notifications | undefined>(undefined);

export function useNotifications(): Notifications | undefined {
  return useContext(NotificationsContext);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { flags } = useConfig();
  const { user } = useAuth();
  if (!flags.notifications || !user) return <>{children}</>;
  return <Live key={user.sub}>{children}</Live>;
}

function Live({ children }: { children: ReactNode }) {
  const api = useApi();
  const auth = useAuth();
  const { wsUrl } = useConfig();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [next, setNext] = useState<string>();
  const apiRef = useRef(api);
  apiRef.current = api;

  const refresh = useCallback(async () => {
    try {
      const page = await apiRef.current<NotificationsResponse>('/me/notifications');
      setItems(page.items);
      setUnread(page.unread);
      setNext(page.next);
    } catch {
      // Shown again on the next push or reconnect.
    }
  }, []);

  // New notifications over a socket of our own; reload the list whenever it (re)connects.
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let attempts = 0;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const connect = async () => {
      const token = await auth.token();
      if (stopped) return;
      const url = new URL(wsUrl);
      if (token) url.searchParams.set('token', token);
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempts = 0;
        void refresh();
        keepalive = setInterval(() => socket?.send(JSON.stringify({ type: 'ping' })), KEEPALIVE_MS);
      };
      socket.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        if (msg.type === 'notifications-read') {
          const ids = new Set(msg.ids);
          setItems((list) => list.map((n) => (ids.has(n.id) ? { ...n, read: true } : n)));
          setUnread(msg.unread);
          return;
        }
        if (msg.type !== 'notification') return;
        const n = msg.notification;
        setItems((list) => (list.some((x) => x.id === n.id) ? list : [n, ...list]));
        setUnread((u) => u + 1);
      };
      socket.onclose = () => {
        clearInterval(keepalive);
        if (stopped) return;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts++);
        setTimeout(() => void connect(), delay);
      };
    };
    // Input, or the tab coming back into view, means the user is here; an idle tab doesn't.
    let lastActive = 0;
    const active = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastActive < ACTIVE_EVERY_MS)
        return;
      if (socket?.readyState !== WebSocket.OPEN) return;
      lastActive = Date.now();
      socket.send(JSON.stringify({ type: 'active' }));
    };
    const events = ['pointerdown', 'keydown', 'visibilitychange'] as const;
    for (const e of events) document.addEventListener(e, active, { passive: true });
    void connect();
    return () => {
      stopped = true;
      clearInterval(keepalive);
      for (const e of events) document.removeEventListener(e, active);
      socket?.close();
    };
  }, [auth, wsUrl, refresh]);

  useEffect(() => {
    setUnreadTitle(unread);
    return () => setUnreadTitle(0);
  }, [unread]);

  const value = useMemo<Notifications>(
    () => ({
      items,
      unread,
      more: next !== undefined,
      loadMore: () => {
        if (!next) return;
        void apiRef
          .current<NotificationsResponse>(`/me/notifications?before=${encodeURIComponent(next)}`)
          .then((page) => {
            setItems((list) => [
              ...list,
              ...page.items.filter((n) => !list.some((x) => x.id === n.id)),
            ]);
            setNext(page.next);
          });
      },
      markRead: (req) => {
        const ids = 'ids' in req ? new Set(req.ids) : undefined;
        setItems((list) => list.map((n) => (!ids || ids.has(n.id) ? { ...n, read: true } : n)));
        void apiRef
          .current<{ unread: number }>('/me/notifications/read', { method: 'POST', body: req })
          .then((r) => setUnread(r.unread), refresh);
      },
    }),
    [items, unread, next, refresh],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/** The bell in the header: unread count, and the latest notifications linking into games. */
export function NotificationBell() {
  const n = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!n) return null;
  const count = n.unread > 49 ? '50+' : String(n.unread);
  return (
    <div className="bell" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={n.unread ? `Notifications, ${count} unread` : 'Notifications'}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">🔔</span>
        {n.unread > 0 && (
          <span className="bell-count" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      {open && (
        <section className="bell-panel" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            {n.unread > 0 && (
              <button type="button" onClick={() => n.markRead({ all: true })}>
                Mark all read
              </button>
            )}
          </div>
          {n.items.length === 0 ? (
            <p className="muted small">Nothing yet.</p>
          ) : (
            <ul>
              {n.items.map((item) => (
                <li key={item.id} className={item.read ? 'read' : 'unread'}>
                  <Link
                    to={`/games/${item.gameId}`}
                    onClick={() => {
                      if (!item.read) n.markRead({ ids: [item.id] });
                      setOpen(false);
                    }}
                  >
                    <span>{item.text}</span>
                    <span className="muted small">
                      {item.gameName} · {ago(item.at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {n.more && (
            <button type="button" onClick={n.loadMore}>
              Older
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function ago(at: string): string {
  const ms = Date.now() - Date.parse(at);
  return ms < 60_000 ? 'just now' : `${formatLeft(ms)} ago`;
}
