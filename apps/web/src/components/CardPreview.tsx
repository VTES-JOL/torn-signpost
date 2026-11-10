/**
 * A large card image beside whatever card the mouse rests on, in a list or a grid, so names
 * and small thumbnails are enough on screen (the deck builder, the card browser).
 */
import type { CardRecord } from '@torn-signpost/cards';
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useCards } from '../content.tsx';

const WIDTH = 250;
const HEIGHT = Math.round((WIDTH * 500) / 358);
const GAP = 12;

export function useCardPreview(): {
  /** Spread onto the element that names the card. */
  bind: (card: CardRecord) => {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  preview: ReactNode;
} {
  const [shown, setShown] = useState<{ card: CardRecord; rect: DOMRect }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!shown) return;
    const hide = () => setShown(undefined);
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [shown]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    bind: (card) => ({
      onPointerEnter: (e) => {
        // A touch has no hover; a tap opens the card instead.
        if (e.pointerType !== 'mouse') return;
        const rect = e.currentTarget.getBoundingClientRect();
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setShown({ card, rect }), 120);
      },
      onPointerLeave: () => {
        clearTimeout(timer.current);
        setShown(undefined);
      },
    }),
    preview: shown ? <CardPreview card={shown.card} rect={shown.rect} /> : null,
  };
}

/** Beside the card's row: on its left in the right half of the window, else on its right. */
function CardPreview({ card, rect }: { card: CardRecord; rect: DOMRect }) {
  const cards = useCards();
  if (cards.state !== 'ready') return null;
  const right = rect.left + rect.width / 2 > window.innerWidth / 2;
  const left = right
    ? Math.max(GAP, rect.left - WIDTH - GAP)
    : Math.min(window.innerWidth - WIDTH - GAP, rect.right + GAP);
  const top = Math.max(GAP, Math.min(rect.top - HEIGHT / 3, window.innerHeight - HEIGHT - GAP));
  return (
    <img
      className="card-preview"
      src={cards.image(card.id, 'full')}
      alt=""
      width={WIDTH}
      height={HEIGHT}
      style={{ left, top }}
    />
  );
}
