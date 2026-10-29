import type { CardRecord } from '@torn-signpost/cards';
import { useEffect, useRef } from 'react';
import { useCards } from '../content.tsx';

/** Full card scan and details in a dialog. */
export function CardDetail({
  card,
  onClose,
}: {
  card: CardRecord | undefined;
  onClose: () => void;
}) {
  const cards = useCards();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (card && !d.open) d.showModal();
    if (!card && d.open) d.close();
  }, [card]);
  return (
    <dialog ref={dialog} className="card-detail" onClose={onClose} aria-label={card?.name}>
      {card && cards.state === 'ready' && (
        <div className="card-detail-body">
          <img
            src={cards.image(card.id, 'full')}
            alt={card.name}
            width={358}
            height={500}
            onError={(e) => {
              e.currentTarget.src = cards.back(card.kind);
            }}
          />
          <div>
            <h2>{card.name}</h2>
            <p className="muted">
              {[
                card.types.join(' / '),
                card.clans?.join(' / '),
                card.sect,
                card.title,
                card.capacity && `capacity ${card.capacity}`,
                card.group && `group ${card.group}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {card.disciplines && (
              <p>
                Disciplines: {card.disciplines.join(card.disciplineMode === 'all' ? ' + ' : ' ')}
              </p>
            )}
            <p className="card-text">{card.text}</p>
            <p className="muted small">
              {card.sets.join(', ')}
              {card.bannedFrom && <strong> · Banned since {card.bannedFrom}</strong>}
              {card.v5 && ' · V5'}
            </p>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
