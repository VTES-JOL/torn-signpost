import type { Meta, StoryObj } from '@storybook/react-vite';
import { WithCards } from '../stories/fixtures.tsx';
import { useCardPreview } from './CardPreview.tsx';

/** `useCardPreview`: rest the mouse on a card name to see the card beside it. */
const meta = {
  title: 'Cards/CardPreview',
  args: { ids: ['201362', '200179', '100001', '101056', '100598'] },
  render: (args) => <Names {...args} />,
} satisfies Meta<{ ids: string[] }>;
export default meta;

function Names({ ids }: { ids: string[] }) {
  const { bind, preview } = useCardPreview();
  return (
    <WithCards>
      {(cards) => (
        <>
          <ul>
            {ids.flatMap((id) => {
              const card = cards.get(id);
              return card
                ? [
                    <li key={id}>
                      <span {...bind(card)}>{card.name}</span>
                    </li>,
                  ]
                : [];
            })}
          </ul>
          {preview}
        </>
      )}
    </WithCards>
  );
}

export const HoverAName: StoryObj<typeof meta> = {};
