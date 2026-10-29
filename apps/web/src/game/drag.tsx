/**
 * Pointer-based drag and drop (UX-02) that works the same for mouse, pen and touch. Drop targets
 * are elements with `data-drop` (`zone:<zoneId>`, `card:<id>` or `pool:<seat>`); while dragging,
 * targets that accept the source get `data-accepts`, and the one under the pointer `data-over`.
 */
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';

export type DragSource =
  | { kind: 'card'; id: string; zone: string }
  | { kind: 'deck'; seat: string; from: 'library' | 'crypt' }
  | { kind: 'pool'; seat: string };

export type DropTarget =
  | { kind: 'zone'; zone: string }
  | { kind: 'card'; id: string }
  | { kind: 'pool'; seat: string };

interface DragContextValue {
  /** Call from onPointerDown. */
  begin(e: React.PointerEvent, source: DragSource, image?: string): void;
}

const DragContext = createContext<DragContextValue>({ begin: () => {} });
export const useDrag = () => useContext(DragContext);

const THRESHOLD = 6;

function parseTarget(value: string): DropTarget | undefined {
  const i = value.indexOf(':');
  const kind = value.slice(0, i);
  const rest = value.slice(i + 1);
  if (kind === 'zone') return { kind, zone: rest };
  if (kind === 'card') return { kind, id: rest };
  if (kind === 'pool') return { kind, seat: rest };
  return undefined;
}

export function DragProvider(props: {
  children: ReactNode;
  accepts: (source: DragSource, target: DropTarget) => boolean;
  onDrop: (source: DragSource, target: DropTarget) => void;
}) {
  const [ghost, setGhost] = useState<{ x: number; y: number; image?: string; label: string }>();
  const latest = useRef(props);
  latest.current = props;

  const begin = useCallback((e: React.PointerEvent, source: DragSource, image?: string) => {
    if (e.button !== 0) return;
    // Stop the browser starting a text selection or native drag, which would cancel the pointer
    // stream mid-drag. The click that follows a short press still fires.
    if (e.pointerType === 'mouse') e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let over: Element | null = null;
    const targets = () => [...document.querySelectorAll<HTMLElement>('[data-drop]')];

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
        dragging = true;
        document.body.classList.add('dragging');
        for (const t of targets()) {
          const target = parseTarget(t.dataset.drop ?? '');
          if (target && latest.current.accepts(source, target)) t.dataset.accepts = '';
        }
      }
      ev.preventDefault();
      setGhost({
        x: ev.clientX,
        y: ev.clientY,
        label: source.kind === 'pool' ? '1 blood' : '',
        ...(image ? { image } : {}),
      });
      const hit =
        document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-accepts]') ?? null;
      if (hit !== over) {
        over?.removeAttribute('data-over');
        hit?.setAttribute('data-over', '');
        over = hit;
      }
    };

    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('dragging');
      for (const t of targets()) {
        delete t.dataset.accepts;
        t.removeAttribute('data-over');
      }
      setGhost(undefined);
    };

    const up = () => {
      const target = over instanceof HTMLElement ? parseTarget(over.dataset.drop ?? '') : undefined;
      const wasDragging = dragging;
      end();
      if (!wasDragging) return;
      // Swallow the click that follows a drag, if any: when the pointer ends on another element the
      // browser sends none, so disarm on the next tick rather than eating a later, real click.
      const swallow = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (target) latest.current.onDrop(source, target);
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', end);
  }, []);

  return (
    <DragContext.Provider value={{ begin }}>
      {props.children}
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden>
          {ghost.image ? <img src={ghost.image} alt="" /> : <span>{ghost.label}</span>}
        </div>
      )}
    </DragContext.Provider>
  );
}
