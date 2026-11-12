import type { Meta, StoryObj } from '@storybook/react-vite';
import { availableActions } from '@torn-signpost/engine';
import { useState } from 'react';
import { Scenario, type ScenarioProps } from '../stories/fixtures.tsx';
import { type Choosing, FlowBar } from './FlowBar.tsx';

/**
 * The bar over the table: what the game is waiting for, and the moves on offer to the viewer.
 * States from the engine's scenarios, with the invented test cards; choosing a move plays it.
 */
const meta = {
  title: 'Game/FlowBar',
  render: (args) => <FlowBarAt {...args} />,
} satisfies Meta<Omit<ScenarioProps, 'children'>>;
export default meta;

type Story = StoryObj<typeof meta>;

function FlowBarAt(props: Omit<ScenarioProps, 'children'>) {
  const [choosing, setChoosing] = useState<Choosing>();
  return (
    <Scenario {...props}>
      {({ client, view, seat, catalog, send }) => (
        <FlowBar
          view={view}
          seat={seat}
          client={client}
          catalog={catalog}
          offers={seat ? availableActions(view, seat, catalog) : []}
          choosing={choosing}
          setChoosing={setChoosing}
          send={(c) => {
            setChoosing(undefined);
            send(c);
          }}
          judge={view.status === 'active' && client.getSnapshot().viewer.kind === 'judge'}
          live={false}
        />
      )}
    </Scenario>
  );
}

const sarah = { kind: 'player', seat: 'S' } as const;
const alexis = { kind: 'player', seat: 'X' } as const;

/** The viewer's minion phase: their decision, with actions on offer. */
export const YourMinionPhase: Story = {
  args: { name: '22-referendums', line: 25, viewer: sarah },
};

/** Someone else's turn: who the table is waiting on, and why. */
export const WaitingOnSomeoneElse: Story = {
  args: { name: '22-referendums', line: 25, viewer: alexis },
};

/** A political action may be blocked: the prey decides first. */
export const BlockDecision: Story = {
  args: { name: '22-referendums', line: 29, viewer: alexis },
};

/** Polling: the caller casts votes from each source in turn. */
export const CastingVotes: Story = {
  args: { name: '22-referendums', line: 46, viewer: sarah },
};

/** Combat, before range: the acting minion's Methuselah has the impulse. */
export const Combat: Story = {
  args: { name: '17-combat-steps', line: 39, viewer: { kind: 'player', seat: 'A' } },
};

/** A player has paused the game. */
export const Paused: Story = {
  args: { name: '12-clock-and-deadlines', line: 32, viewer: { kind: 'player', seat: 'A' } },
};

/** The game is over: the bar says why. */
export const GameOver: Story = {
  args: { name: '14-game-end', viewer: { kind: 'player', seat: 'A' } },
};
