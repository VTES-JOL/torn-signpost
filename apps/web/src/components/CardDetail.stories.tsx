import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { WithCard } from '../stories/fixtures.tsx';
import { CardDetail } from './CardDetail.tsx';

/** The card dialog: the full scan and the card's details. Cards by VEKN ID, from the content pack. */
const meta = {
  title: 'Cards/CardDetail',
  args: { id: '201362', onClose: fn() },
  argTypes: { id: { control: 'text', description: 'VEKN card ID' } },
  parameters: { layout: 'fullscreen' },
  render: ({ id, onClose }) => (
    <WithCard id={id}>{(card) => <CardDetail card={card} onClose={onClose} />}</WithCard>
  ),
} satisfies Meta<{ id: string; onClose: () => void }>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Vampire: Story = {};
export const Equipment: Story = { args: { id: '100001' } };
export const PoliticalAction: Story = { args: { id: '101056' } };
