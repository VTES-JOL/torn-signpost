import type { CardRecord } from '@torn-signpost/cards';
import { useState } from 'react';
import { CardDetail } from '../components/CardDetail.tsx';
import { CardSearch } from '../components/CardSearch.tsx';

/** The card database, open to guests (DECK-02). */
export function CardsPage() {
  const [open, setOpen] = useState<CardRecord>();
  return (
    <section>
      <h1>Cards</h1>
      <CardSearch onOpen={setOpen} />
      <CardDetail card={open} onClose={() => setOpen(undefined)} />
    </section>
  );
}
