import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { CardSearch } from './CardSearch.tsx';

/** Card search with filters (DECK-02), over the whole content pack. */
const meta = {
  title: 'Cards/CardSearch',
  component: CardSearch,
  args: { onOpen: fn() },
  argTypes: {
    format: { control: 'radio', options: [undefined, 'standard', 'v5'] },
    counts: { control: false },
  },
} satisfies Meta<typeof CardSearch>;
export default meta;

type Story = StoryObj<typeof meta>;

/** The card browser: a grid of results, filters open. */
export const Browser: Story = {};

/** In the deck builder: a narrow list, an add button on each card, and the copies already in. */
export const DeckBuilder: Story = {
  args: { compact: true, onPick: fn(), onRemove: fn() },
  render: function DeckBuilder(args) {
    const [counts, setCounts] = useState(new Map<string, number>());
    const change = (id: string, by: number) =>
      setCounts((c) => {
        const next = new Map(c);
        const n = (next.get(id) ?? 0) + by;
        if (n > 0) next.set(id, n);
        else next.delete(id);
        return next;
      });
    return (
      <div style={{ maxWidth: 420 }}>
        <CardSearch
          {...args}
          counts={counts}
          onPick={(card) => {
            args.onPick?.(card);
            change(card.id, 1);
          }}
          onRemove={(card) => {
            args.onRemove?.(card);
            change(card.id, -1);
          }}
        />
      </div>
    );
  },
};

/** Limited to the V5 card pool (DECK-04). */
export const V5Only: Story = { args: { format: 'v5' } };
